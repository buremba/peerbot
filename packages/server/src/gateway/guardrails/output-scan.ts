/**
 * Shared output-stage guardrail enforcement.
 *
 * Output guardrails (secret-scan, pii-scan, …) must run on EVERY response
 * surface, not just Chat SDK platforms. This module is the single place the
 * stage is resolved + run + audited so the two renderer-agnostic call sites —
 * `ChatResponseBridge` (chat platforms) and `UnifiedThreadResponseConsumer`
 * (the API/SSE/web path via `ApiResponseRenderer`) — share identical, vetted
 * logic instead of one of them silently lacking enforcement.
 *
 * Like all guardrails it fails OPEN: a runner/lookup error logs and returns
 * `null` (no block) rather than dropping a legitimate reply.
 */

import {
  createLogger,
  type GuardrailRegistry,
  runGuardrailInstances,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { resolveAgentGuardrails } from "./aggregator.js";
import { recordGuardrailTrip } from "./audit.js";

const logger = createLogger("output-guardrail");

/**
 * Streaming chunks split arbitrarily across token boundaries; a secret like
 * `sk-abc…` can arrive as `"sk-an"` then `"t-…"` and bypass any per-delta
 * regex. Callers keep a rolling tail of recent emitted text and scan
 * `tail + delta` so patterns straddling a chunk boundary still match. The scan
 * window is bounded at 2× the tail to keep regex cost proportional to the
 * chunk being processed, not the entire stream.
 */
export const OUTPUT_GUARDRAIL_TAIL_CHARS = 256;
export const OUTPUT_GUARDRAIL_SCAN_WINDOW = OUTPUT_GUARDRAIL_TAIL_CHARS * 2;

export interface OutputScanContext {
  agentId: string;
  organizationId?: string;
  userId: string;
  conversationId?: string;
  platform: string;
}

export interface OutputGuardrailTrip {
  guardrail: string;
  reason?: string;
}

/**
 * Run output-stage guardrails for `scanText`. Returns the trip outcome
 * (already audited via `recordGuardrailTrip`) on block, or `null` when safe to
 * send. Returns `null` (pass) when guardrails aren't wired, the text is empty,
 * no agent is resolved, the agent has no output guardrails, or the runner
 * throws — guardrails fail open.
 */
export async function runOutputGuardrailScan(
  registry: GuardrailRegistry | undefined,
  settingsStore: AgentSettingsStore | undefined,
  scanText: string,
  ctx: OutputScanContext
): Promise<OutputGuardrailTrip | null> {
  if (!registry || !settingsStore) return null;
  if (!scanText) return null;
  if (!ctx.agentId) return null;

  try {
    const settings = await settingsStore.getSettings(ctx.agentId);
    const resolved = resolveAgentGuardrails(
      settings ?? { guardrails: [] },
      (settings?.skillsConfig?.skills ?? []).filter((s) => s.enabled),
      registry
    );
    const list = resolved.byStage.output;
    if (list.length === 0) return null;

    const outcome = await runGuardrailInstances("output", list, {
      agentId: ctx.agentId,
      userId: ctx.userId,
      text: scanText,
      platform: ctx.platform,
      conversationId: ctx.conversationId,
    });
    if (!outcome.tripped) return null;

    // Fire-and-forget — the block decision must not wait on the audit write.
    void recordGuardrailTrip({
      organizationId: ctx.organizationId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      stage: "output",
      guardrail: outcome.tripped.guardrail,
      reason: outcome.tripped.reason,
      metadata: outcome.tripped.metadata,
    });
    return {
      guardrail: outcome.tripped.guardrail,
      reason: outcome.tripped.reason,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Output guardrail check failed — proceeding without guardrails"
    );
    return null;
  }
}

/**
 * Stateful output-guardrail scanner for renderers that lack their own stream
 * state (the API/SSE path). Owns the per-session rolling tail and a blocked-set
 * so once a stream trips, subsequent deltas on this pod are suppressed. The
 * authoritative enforcement is the terminal `scanFinal` on the worker's full
 * `finalText` (owner-gated, replica-safe); per-delta scanning is best-effort
 * defense-in-depth (deltas aren't owner-gated under N>1, so a delta claimed on
 * another pod is lost anyway — the terminal scan re-checks the full text).
 */
export class OutputGuardrailScanner {
  private registry?: GuardrailRegistry;
  private settingsStore?: AgentSettingsStore;
  private tails = new Map<string, string>();
  private blocked = new Set<string>();

  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.registry = registry;
    this.settingsStore = settingsStore;
  }

  get enabled(): boolean {
    return !!(this.registry && this.settingsStore);
  }

  isBlocked(key: string): boolean {
    return this.blocked.has(key);
  }

  /**
   * Scan a streaming delta using `tail + delta`. On a trip, marks the session
   * blocked and clears the tail. Returns the trip (already audited) or `null`.
   */
  async scanDelta(
    key: string,
    delta: string,
    ctx: OutputScanContext
  ): Promise<OutputGuardrailTrip | null> {
    if (!this.enabled || !delta) return null;
    const combined = (this.tails.get(key) ?? "") + delta;
    const window =
      combined.length > OUTPUT_GUARDRAIL_SCAN_WINDOW
        ? combined.slice(-OUTPUT_GUARDRAIL_SCAN_WINDOW)
        : combined;
    this.tails.set(key, window);

    const trip = await runOutputGuardrailScan(
      this.registry,
      this.settingsStore,
      window,
      ctx
    );
    if (trip) {
      this.blocked.add(key);
      this.tails.delete(key);
    }
    return trip;
  }

  /**
   * Scan the authoritative final text at terminal time. Returns the trip
   * (already audited) or `null`. Does not need prior delta state — it scans the
   * full text, so it blocks correctly even when delta rows landed on other
   * replicas.
   */
  async scanFinal(
    key: string,
    text: string,
    ctx: OutputScanContext
  ): Promise<OutputGuardrailTrip | null> {
    if (!this.enabled) return null;
    const trip = await runOutputGuardrailScan(
      this.registry,
      this.settingsStore,
      text,
      ctx
    );
    if (trip) this.blocked.add(key);
    return trip;
  }

  /** Release per-session state once a stream reaches its terminal row. */
  clear(key: string): void {
    this.tails.delete(key);
    this.blocked.delete(key);
  }
}

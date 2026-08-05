/**
 * HTTP implementation of WorkerTransport
 * Sends worker responses to gateway via HTTP POST requests
 */

import {
  createLogger,
  retryWithBackoff,
  type AgentErrorContext,
  type WorkerTransport,
  type WorkerTransportConfig,
} from "@lobu/core";
import { createGatewayClient } from "@lobu/plugin-toolkit";
import type { ResponseData } from "./types";
import { getWorkerTokenManager } from "./worker-token-manager";

const logger = createLogger("http-worker-transport");

/**
 * HTTP transport for worker-to-gateway communication
 * Implements retry logic and deduplication for streaming responses
 */
export class HttpWorkerTransport implements WorkerTransport {
  private gatewayUrl: string;
  private userId: string;
  private channelId: string;
  private conversationId: string;
  private originalMessageTs: string;
  private botResponseTs?: string;
  public processedMessageIds: string[] = [];
  private jobId?: string;
  private teamId: string;
  private platform?: string;
  private platformMetadata?: Record<string, unknown>;
  private accumulatedStreamContent: string[] = [];
  private lastStreamDelta: string = "";
  // The authoritative full assistant text, recorded whenever the worker sees
  // an explicit final result (the `isFinal` delta). `signalCompletion()` sends
  // THIS as `finalText` rather than re-deriving it from the append-only
  // `accumulatedStreamContent` dedupe buffer. The buffer can hold
  // partial_stream + full_final in the divergent-final case (when the final
  // result is neither identical to nor a prefix-extension of what was
  // streamed), which would garble the cross-pod/history `finalText`.
  // `undefined` until an explicit final is seen — pure-streaming turns fall
  // back to the accumulation (which IS the final text there).
  private finalText?: string;
  /**
   * Distinct tool names finished this turn (`tool_execution_end`). Stamped on
   * the terminal completion row so gateway output guardrails can require a
   * tool without a separate durable ledger.
   */
  private toolsUsed = new Set<string>();
  /**
   * Latched when `send_message` posted into the conversation this turn is
   * replying to. Stamped on the terminal completion so the gateway skips
   * delivering `finalText` as a second message. A latch, not a count: any
   * number of in-band posts collapses to the same "already answered" fact.
   */
  private repliedInBand = false;
  /**
   * Lobu provider slug model resolution picked for this turn, stamped on the
   * terminal completion. Undefined until resolution runs, so a turn that fails
   * before it reports no provider rather than a wrong one.
   */
  private providerSlug: string | undefined;
  /**
   * Once-per-turn latch for user-facing errors. Three uncoordinated emitters
   * can report the SAME failed turn — `worker.ts`'s result-false branch,
   * `worker.ts`'s catch branch, and `sse-client.ts`'s outer catch — and every
   * `signalError` is a terminal POST the gateway turns into its own chat
   * message. That is how one Telegram question produced a 401 CTA, an answer,
   * and a crash blob. The FIRST error wins: it carries the real classification
   * (later re-signals are typically code-less). This transport is per-turn, so
   * a new turn starts unlatched.
   */
  private errorSignalled = false;
  /**
   * The in-flight terminal error delivery, claimed BEFORE the first await.
   * `errorSignalled` cannot elect the winner on its own: it is set only after
   * `sendResponse` resolves (deliberately — see `signalError`), so two
   * overlapping callers would both pass the latch check and both POST, which is
   * the duplicate this latch exists to prevent. Cleared when delivery fails so
   * a later signal can still retry.
   */
  private errorSignalInFlight?: Promise<void>;

  constructor(config: WorkerTransportConfig) {
    this.gatewayUrl = config.gatewayUrl;
    // Seed the process-wide token manager from the boot token if it hasn't been
    // initialized yet (the manager otherwise lazy-inits from env). The manager
    // is the single source of truth for the live token — this transport's
    // gateway POSTs read it via fetchWithRefresh, so there is no per-transport
    // token field to drift.
    getWorkerTokenManager().seed(config.workerToken);
    this.userId = config.userId;
    this.channelId = config.channelId;
    this.conversationId = config.conversationId;
    this.originalMessageTs = config.originalMessageTs;
    this.botResponseTs = config.botResponseTs;
    this.teamId = config.teamId;
    this.platform = config.platform;
    this.platformMetadata = config.platformMetadata;
    this.processedMessageIds = config.processedMessageIds || [];
  }

  setJobId(jobId: string): void {
    this.jobId = jobId;
  }

  addProcessedMessageId(messageId: string): void {
    if (!this.processedMessageIds.includes(messageId)) {
      this.processedMessageIds.push(messageId);
    }
  }

  /** Record a tool name finished this turn (from `tool_execution_end`). */
  recordToolUsed(toolName: string): void {
    const name = toolName.trim();
    if (name) this.toolsUsed.add(name);
  }

  /**
   * Record that the agent answered in-band this turn — it posted into the
   * conversation it is replying to, so the terminal reply must not also be
   * delivered.
   */
  recordInBandReply(): void {
    this.repliedInBand = true;
  }

  /**
   * Latch the Lobu provider slug that resolution picked for this turn, so the
   * terminal completion can tell the gateway which provider just proved
   * healthy. Mirrors how `errorContext.provider` attributes a failure.
   */
  recordProviderSlug(slug: string): void {
    this.providerSlug = slug;
  }

  async signalDone(finalDelta?: string): Promise<void> {
    // Send final delta if there is one
    if (finalDelta) {
      await this.sendStreamDelta(finalDelta, false, true);
    }
    await this.signalCompletion();
  }

  async sendStreamDelta(
    delta: string,
    isFullReplacement: boolean = false,
    isFinal: boolean = false
  ): Promise<void> {
    let actualDelta = delta;

    // Handle final result with deduplication
    if (isFinal) {
      // `delta` is the complete final assistant text. Record it as the
      // authoritative `finalText` regardless of which dedupe branch we take
      // below — the dedupe only controls what (if anything) is *streamed* to
      // the client, never what the terminal completion row carries cross-pod.
      this.finalText = delta;

      logger.info(`🔍 Processing final result with deduplication`);
      logger.info(`Final text length: ${delta.length} chars`);
      const accumulatedStr = this.accumulatedStreamContent.join("");
      const accumulatedLength = accumulatedStr.length;
      logger.info(`Accumulated length: ${accumulatedLength} chars`);

      // Check if final result is identical to what we've already sent
      if (delta === accumulatedStr) {
        logger.info(
          `✅ Final result is identical to accumulated content - skipping duplicate`
        );
        return;
      }

      // Check if accumulated content is a prefix of final result
      if (delta.startsWith(accumulatedStr)) {
        // Only send the missing part
        actualDelta = delta.slice(accumulatedLength);
        if (actualDelta.length === 0) {
          logger.info(
            `✅ Final result fully contained in accumulated content - skipping`
          );
          return;
        }
        logger.info(
          `📝 Final result has ${actualDelta.length} new chars - sending delta only`
        );
      } else if (accumulatedLength > 0) {
        const normalizedFinal = this.normalizeForComparison(delta);
        const normalizedLastDelta = this.normalizeForComparison(
          this.lastStreamDelta
        );

        if (
          normalizedFinal.length > 0 &&
          normalizedFinal === normalizedLastDelta
        ) {
          logger.info(
            `✅ Final result matches last streamed delta (normalized) - skipping duplicate`
          );
          return;
        }

        // Content differs - log warning and send full final result
        logger.warn(`⚠️  Final result differs from accumulated content!`);
        logger.warn(
          `First 100 chars of accumulated: ${accumulatedStr.substring(0, 100)}`
        );
        logger.warn(`First 100 chars of final: ${delta.substring(0, 100)}`);
        logger.info(`📤 Sending full final result (${delta.length} chars)`);
      }
    }

    // Track accumulated content for deduplication using array buffer (O(1) append)
    if (!isFullReplacement) {
      this.accumulatedStreamContent.push(actualDelta);
    } else {
      this.accumulatedStreamContent = [actualDelta];
    }
    this.lastStreamDelta = actualDelta;

    await this.sendResponse(
      this.buildBaseResponse({
        delta: actualDelta,
        isFullReplacement,
      })
    );
  }

  async signalCompletion(): Promise<void> {
    // Carry the full assistant text on the terminal row. The reply text is
    // otherwise only in the gateway's per-pod streaming buffer (built from the
    // delta rows on whichever replica drained them); a post-once renderer
    // (Slack) that completes on a different replica has no buffer and would
    // drop the reply. `finalText` makes the completion self-contained so any
    // replica can deliver it. (Empty string when nothing was streamed.)
    //
    // Prefer the authoritative final recorded from the `isFinal` delta. Only
    // fall back to the accumulated stream buffer when no explicit final was
    // seen (a pure-streaming turn, where the accumulation IS the final text).
    // Re-deriving from the buffer unconditionally would garble the divergent-
    // final case, where it holds partial_stream + full_final.
    await this.sendResponse(
      this.buildBaseResponse({
        processedMessageIds: this.processedMessageIds,
        finalText: this.finalText ?? this.accumulatedStreamContent.join(""),
        // Always stamp (including empty) so the gateway can tell "no tools"
        // from "worker too old to report" (undefined).
        toolsUsed: [...this.toolsUsed],
        // Only stamp the true case: an absent field means "nothing posted
        // in-band" AND "worker too old to report" alike, and both must render
        // the reply. Fails toward delivering, never toward silence.
        ...(this.repliedInBand ? { repliedInBand: true } : {}),
        // Success-side health signal: this provider just served a turn end to
        // end, so the gateway can clear any error it recorded for it. Omitted
        // when resolution never ran — silence, not a claim of health.
        ...(this.providerSlug ? { providerSlug: this.providerSlug } : {}),
      })
    );
  }

  async signalError(
    error: Error,
    errorCode?: string,
    errorContext?: AgentErrorContext
  ): Promise<void> {
    // Drop every error after the first for this turn. Keep the detail in the
    // logs — the suppressed one is often the more specific provider string, and
    // losing it silently is what made these turns undiagnosable.
    if (this.errorSignalled || this.errorSignalInFlight) {
      logger.warn(
        `[WORKER-HTTP] Suppressing duplicate error signal for this turn (code=${
          errorCode ?? "none"
        }): ${error.message}`
      );
      return;
    }
    // Claim the turn BEFORE the first await. There is no await between the
    // check above and this assignment, so the claim is atomic against another
    // `signalError` interleaving here — without it, two concurrent callers both
    // see an unset `errorSignalled` and both post a user-facing error.
    const delivery = this.sendResponse(
      this.buildBaseResponse({
        error: error.message,
        processedMessageIds: this.processedMessageIds,
        toolsUsed: [...this.toolsUsed],
        ...(errorCode && { errorCode }),
        ...(errorContext && { errorContext }),
      })
    );
    this.errorSignalInFlight = delivery;
    try {
      await delivery;
    } catch (err) {
      // Release the claim so a later signal can retry. `sendResponse` retries
      // internally and throws when it ultimately fails; holding the claim (or
      // latching) here would permanently suppress every later attempt, so the
      // user would get NO terminal error at all — strictly worse than the
      // duplicate this latch exists to prevent.
      this.errorSignalInFlight = undefined;
      throw err;
    }
    // Latch only AFTER the terminal response is actually delivered.
    this.errorSignalled = true;
  }

  async sendStatusUpdate(elapsedSeconds: number, state: string): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        statusUpdate: { elapsedSeconds, state },
      })
    );
  }

  async sendCustomEvent(
    name: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.sendResponse(
      this.buildBaseResponse({
        customEvent: { name, data },
      })
    );
  }

  /**
   * Build base response payload with common fields shared across all response types
   */
  private buildBaseResponse(
    additionalFields?: Partial<ResponseData>
  ): ResponseData {
    return {
      messageId: this.originalMessageTs,
      channelId: this.channelId,
      conversationId: this.conversationId,
      userId: this.userId,
      teamId: this.teamId,
      timestamp: Date.now(),
      originalMessageId: this.originalMessageTs,
      botResponseId: this.botResponseTs,
      ...additionalFields,
    };
  }

  /**
   * Build exec response payload with exec-specific fields
   */
  private buildExecResponse(
    execId: string,
    additionalFields: Partial<ResponseData>
  ): ResponseData {
    return this.buildBaseResponse({ execId, ...additionalFields });
  }

  /**
   * Send exec output (stdout/stderr) to gateway
   */
  async sendExecOutput(
    execId: string,
    stream: "stdout" | "stderr",
    content: string
  ): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { delta: content, execStream: stream })
    );
  }

  /**
   * Send exec completion to gateway
   */
  async sendExecComplete(execId: string, exitCode: number): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { execExitCode: exitCode })
    );
  }

  /**
   * Send exec error to gateway
   */
  async sendExecError(execId: string, errorMessage: string): Promise<void> {
    await this.sendResponse(
      this.buildExecResponse(execId, { error: errorMessage })
    );
  }

  private async sendResponse(data: ResponseData): Promise<void> {
    const responseUrl = `${this.gatewayUrl}/worker/response`;
    const basePayload = {
      ...data,
      ...(this.platform && !data.platform ? { platform: this.platform } : {}),
      ...(!data.platformMetadata && this.platformMetadata
        ? { platformMetadata: this.platformMetadata }
        : {}),
    };
    const payload = this.jobId
      ? { jobId: this.jobId, ...basePayload }
      : basePayload;

    await retryWithBackoff(
      async () => {
        // Don't `JSON.stringify(payload)` just to truncate it for a log line —
        // that's a full serialize-then-discard on the per-delta hot path
        // (and platformMetadata can be large). Log the identifying fields only.
        logger.info(
          `[WORKER-HTTP] Sending to ${responseUrl}: messageId=${payload.messageId ?? ""}${
            payload.delta ? ` deltaLength=${payload.delta.length}` : ""
          }${payload.statusUpdate ? " statusUpdate" : ""}${payload.customEvent ? ` customEvent=${payload.customEvent.name}` : ""}`
        );

        // Route through the token manager so a turn running past the token's
        // 2h TTL refreshes (proactively when near expiry, reactively on a 401)
        // against the deployment-liveness-gated /worker/token/refresh endpoint.
        // The manager is the single source of truth for the live token; it
        // hands the current token to this callback, which binds a fresh gateway
        // client to that live bearer for each (re)try — keeping the shared
        // auth/content-type/timeout boilerplate from the gateway client.
        const response = await getWorkerTokenManager().fetchWithRefresh((tok) =>
          createGatewayClient({ baseUrl: this.gatewayUrl, token: tok }).request(
            "/worker/response",
            {
              method: "POST",
              body: JSON.stringify(payload),
              timeoutMs: 30_000,
            }
          )
        );

        if (!response.ok) {
          throw new Error(
            `Failed to send response to dispatcher: ${response.status} ${response.statusText}`
          );
        }

        logger.debug("Response sent to dispatcher successfully");
      },
      {
        maxRetries: 2,
        baseDelay: 1000,
        onRetry: (attempt, error) => {
          logger.warn(`Failed to send response (attempt ${attempt}/2):`, error);
        },
      }
    );
  }

  private normalizeForComparison(text: string): string {
    return text.replace(/\r\n/g, "\n").trim();
  }
}

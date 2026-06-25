import {
  type AgentInlineGuardrail,
  type AgentSettings,
  type Guardrail,
  type GuardrailRegistry,
  type GuardrailStage,
  type SkillConfig,
  type SkillPreToolGuardrail,
  createLogger,
} from "@lobu/core";
import {
  createJudgeGuardrail,
  inlineJudgeHash,
} from "./judge-factory.js";

const logger = createLogger("guardrail-aggregator");

interface AgentGuardrailExtras {
  /**
   * Operator-authored custom guardrails (`AgentSettings.guardrailsInline`).
   * Each materializes into a judge guardrail under its operator-given `name`.
   * Callers pass only the entries they want active (filter on `enabled`).
   */
  inline?: AgentInlineGuardrail[];
  /**
   * Operator's exclude list — names matched against the resolved guardrails'
   * `.name` (including synthesized inline names). Applied last.
   */
  disabled?: string[];
}

/**
 * The agent's active custom guardrails, shaped for `extras.inline`. Disabled
 * entries are kept in settings (so the operator can flip them back on) but
 * never resolved into a run — every resolve call site filters through here so
 * the input/output/pre-tool paths stay consistent.
 */
export function enabledInlineGuardrails(
  settings: Pick<AgentSettings, "guardrailsInline"> | null | undefined
): AgentInlineGuardrail[] {
  return (settings?.guardrailsInline ?? []).filter((g) => g.enabled);
}

interface ResolvedAgentGuardrails {
  /** Effective per-stage guardrail instances, after merge + dedup + exclude. */
  byStage: Record<GuardrailStage, Guardrail[]>;
  /**
   * Names per stage in resolution order — useful for logging and for any
   * caller that wants to pass `enabled` to `runGuardrails(registry, …)` via
   * the registry. The actual ad-hoc inline + skill-pretool guardrails are
   * NOT registered globally on the shared registry — the aggregator returns
   * them already-resolved so the gateway can run them directly.
   */
  names: Record<GuardrailStage, string[]>;
}

function emptyByStage(): Record<GuardrailStage, Guardrail[]> {
  return { input: [], output: [], "pre-tool": [] };
}
function emptyNames(): Record<GuardrailStage, string[]> {
  return { input: [], output: [], "pre-tool": [] };
}

/**
 * Resolve the full set of guardrails to run for an agent. Combines:
 *   1. `agentSettings.guardrails` — built-in / globally-registered names.
 *   2. Skill-declared pre-tool guardrails (built-in by name OR inline judge).
 *   3. `extras.inline` — agent-declared inline judges (`guardrails_inline`).
 * Then subtracts `extras.disabled` (matched against the final `.name`).
 *
 * Dedup is name-keyed within a stage: if both the agent's enabled-list and a
 * skill declare `secret-scan` for pre-tool, only one instance runs. Agent
 * entries win over skill entries on collision (operator intent dominates).
 *
 * Inline judges (from skills or from the agent) are NOT registered on the
 * shared registry — the aggregator constructs them in-place and returns
 * them so the runner can include them alongside registry-resolved entries.
 *
 * Unknown built-in names are logged and skipped — same posture as
 * `GuardrailRegistry.resolve()`.
 */
export function resolveAgentGuardrails(
  agentSettings: Pick<AgentSettings, "guardrails">,
  enabledSkills: readonly SkillConfig[],
  registry: GuardrailRegistry,
  extras: AgentGuardrailExtras = {}
): ResolvedAgentGuardrails {
  const byStage = emptyByStage();
  const names = emptyNames();
  // Per-stage name -> Guardrail map, used for dedup. Insertion order matters:
  // we want agent entries to win, so we push them first and reject later
  // duplicates from skills.
  const seen: Record<GuardrailStage, Map<string, Guardrail>> = {
    input: new Map(),
    output: new Map(),
    "pre-tool": new Map(),
  };

  // ── 1. Agent's enabled built-ins (all stages) ──────────────────────────
  const agentEnabled = agentSettings.guardrails ?? [];
  if (agentEnabled.length > 0) {
    for (const stage of ["input", "output", "pre-tool"] as const) {
      const resolved = registry.resolve(stage, agentEnabled);
      for (const g of resolved) {
        if (!seen[stage].has(g.name)) {
          seen[stage].set(g.name, g);
        }
      }
    }
  }

  // ── 2. Skill-declared pre-tool guardrails ──────────────────────────────
  for (const skill of enabledSkills) {
    if (!skill.enabled) continue;
    const preToolList = skill.guardrails?.["pre-tool"];
    if (!preToolList || preToolList.length === 0) continue;
    for (const entry of preToolList) {
      const g = materializeSkillPreTool(entry, skill, registry);
      if (!g) continue;
      if (!seen["pre-tool"].has(g.name)) {
        seen["pre-tool"].set(g.name, g);
      }
    }
  }

  // ── 3. Agent-declared inline guardrails ────────────────────────────────
  // Built-ins (step 1) are seen first, so a custom guardrail whose name
  // collides with a built-in at the same stage is dropped here — the create/
  // edit UI rejects such names up front so this stays a defensive guard.
  for (const entry of extras.inline ?? []) {
    if (entry.enabled === false) continue;
    const g = createJudgeGuardrail(entry.stage, entry.policy, {
      name: entry.name,
      model: entry.model,
      tools: entry.tools,
    });
    if (!seen[entry.stage].has(g.name)) {
      seen[entry.stage].set(g.name, g);
    }
  }

  // ── 4. Apply operator exclude list ─────────────────────────────────────
  const disabled = new Set(extras.disabled ?? []);
  for (const stage of ["input", "output", "pre-tool"] as const) {
    for (const [name, g] of seen[stage]) {
      if (disabled.has(name)) continue;
      byStage[stage].push(g);
      names[stage].push(name);
    }
  }

  return { byStage, names };
}

function materializeSkillPreTool(
  entry: SkillPreToolGuardrail,
  skill: SkillConfig,
  registry: GuardrailRegistry
): Guardrail | null {
  switch (entry.kind) {
    case "builtin": {
      const found = registry.get("pre-tool", entry.name);
      if (!found) {
        logger.warn(
          { skill: skill.name, builtin: entry.name },
          "Skill referenced unknown built-in guardrail; skipping"
        );
        return null;
      }
      // Built-ins don't honor per-tool narrowing — the discriminated union
      // doesn't expose `tools` on this arm, pushing skill authors to the
      // `judge` arm when they need it.
      return found;
    }
    case "judge":
      return createJudgeGuardrail("pre-tool", entry.policy, {
        // Stable prefix so operators can disable via `guardrails_disabled`.
        // Skill name + `tools` are part of the hash so two skills with
        // identical policy text don't collide, and the same policy with
        // different tool narrowings produces distinct guardrails (otherwise
        // the aggregator's dedup would drop the second narrowing).
        name: `skill:${skill.name}:inline:pre-tool:${inlineJudgeHash(entry.policy, entry.tools)}`,
        tools: entry.tools,
        // Skills can pin their own judge model; falls back to the gateway
        // default (EGRESS_JUDGE_MODEL) when omitted.
        model: entry.model,
      });
    default: {
      // Exhaustiveness guard — TS errors if `SkillPreToolGuardrail` grows
      // a new variant not handled above.
      const _exhaustive: never = entry;
      logger.warn(
        { skill: skill.name, entry: _exhaustive },
        "Skill pre-tool guardrail entry had unknown kind; skipping"
      );
      return null;
    }
  }
}

import { createLogger } from "../logger";
import type { Guardrail, GuardrailStage } from "./types";

const logger = createLogger("guardrail-registry");

/**
 * Registry of guardrails keyed by `stage + name`. Callers register guardrails
 * at startup (builtins + plugin-provided); the runner filters by stage and
 * by a per-agent enable list.
 */
export class GuardrailRegistry {
  private byStage = new Map<GuardrailStage, Map<string, Guardrail>>();

  register<S extends GuardrailStage>(guardrail: Guardrail<S>): void {
    let stageMap = this.byStage.get(guardrail.stage);
    if (!stageMap) {
      stageMap = new Map();
      this.byStage.set(guardrail.stage, stageMap);
    }
    if (stageMap.has(guardrail.name)) {
      throw new Error(
        `Guardrail "${guardrail.name}" already registered for stage "${guardrail.stage}"`
      );
    }
    stageMap.set(guardrail.name, guardrail as Guardrail);
    logger.debug(
      { name: guardrail.name, stage: guardrail.stage },
      "Guardrail registered"
    );
  }

  get(stage: GuardrailStage, name: string): Guardrail | undefined {
    return this.byStage.get(stage)?.get(name);
  }

  list(stage: GuardrailStage): Guardrail[] {
    const stageMap = this.byStage.get(stage);
    return stageMap ? Array.from(stageMap.values()) : [];
  }

  /**
   * Resolve the guardrails to run for a given stage and an agent's enable
   * list. Unknown names are logged and skipped — a missing guardrail should
   * never silently block a message, but operators need to see the drift.
   */
  resolve(stage: GuardrailStage, enabled: readonly string[]): Guardrail[] {
    const stageMap = this.byStage.get(stage);
    if (!stageMap) return [];
    const out: Guardrail[] = [];
    for (const name of enabled) {
      const g = stageMap.get(name);
      if (g) {
        out.push(g);
      } else {
        logger.warn(
          { name, stage },
          "Enabled guardrail not found in registry; skipping"
        );
      }
    }
    return out;
  }
}

import crypto from "node:crypto";
import type { AgentInlineGuardrail } from "@lobu/core";
import { createLogger, normalizeDomainPattern } from "@lobu/core";

const logger = createLogger("policy-store");

/**
 * Per-domain rule that routes matching requests through a named egress judge.
 * Internal to the egress policy plane (the public agent-facing surface is the
 * `egress`-stage inline guardrail + its `domains` selector).
 */
interface JudgedDomainRule {
  /** Domain pattern — exact or `.wildcard`, same format as allow/deny lists. */
  domain: string;
  /** Named judge policy key. */
  judge?: string;
}

/**
 * Per-agent bundle of egress judge policies. Populated by the deployment
 * manager when syncing agent settings; read by the HTTP proxy when a
 * request needs judge evaluation.
 */
interface JudgePolicyBundle {
  /** Domain rules that require a judge verdict. */
  judgedDomains: JudgedDomainRule[];
  /** Named judge policy texts. */
  judges: Record<string, string>;
  /** Optional per-judge model override, keyed by judge name. */
  judgeModels?: Record<string, string>;
}

/**
 * Resolved judge rule data returned by {@link PolicyStore.resolve}.
 * `policy` is the composed policy text, `policyHash` keys the verdict cache,
 * and `judgeModel` is the per-judge model (undefined falls back to the
 * gateway default in the {@link EgressJudge}/JudgeRunner downstream).
 */
export interface ResolvedJudgeRule {
  judgeName: string;
  policy: string;
  policyHash: string;
  judgeModel?: string;
}

interface PreparedJudge {
  policy: string;
  policyHash: string;
  model?: string;
}

interface PreparedBundle {
  judgedDomains: JudgedDomainRule[];
  preparedJudges: Record<string, PreparedJudge>;
}

/**
 * In-memory store of per-agent egress-judge policies. Thread-safe by virtue
 * of single-threaded Node event loop; syncs happen on deploy/reload.
 *
 * Composed policy text and its hash are computed once at `set()` time and
 * reused on every `resolve()` so the hot path does no SHA256 work.
 *
 * Keyed by `(organizationId, agentId)`. Agent ids are per-org-unique on
 * paper but bugs in upstream code (or a malicious sync from another tenant)
 * must never overwrite policy across orgs — that turns the verdict-cache
 * org scoping into theatre. The key here is the safety net.
 */
export class PolicyStore {
  private readonly policies = new Map<string, PreparedBundle>();

  private static composeKey(organizationId: string, agentId: string): string {
    return `${organizationId}|${agentId}`;
  }

  set(
    organizationId: string,
    agentId: string,
    bundle: JudgePolicyBundle
  ): void {
    const prepared = prepareBundle(organizationId, agentId, bundle);
    this.policies.set(PolicyStore.composeKey(organizationId, agentId), prepared);
    logger.debug("Set egress policy bundle", {
      organizationId,
      agentId,
      domains: prepared.judgedDomains.length,
      judges: Object.keys(prepared.preparedJudges).length,
    });
  }

  clear(organizationId: string, agentId: string): void {
    this.policies.delete(PolicyStore.composeKey(organizationId, agentId));
  }

  /**
   * Resolve a judge rule for a hostname under an `(org, agent)` pair.
   * Rules use the same domain pattern format as allow/deny lists. Exact
   * match is preferred; wildcard patterns (`.example.com`) match the root
   * plus any subdomain.
   */
  resolve(
    organizationId: string,
    agentId: string,
    hostname: string
  ): ResolvedJudgeRule | undefined {
    const prepared = this.policies.get(
      PolicyStore.composeKey(organizationId, agentId)
    );
    if (!prepared || prepared.judgedDomains.length === 0) {
      return undefined;
    }

    const matched = findMatchingRule(hostname, prepared.judgedDomains);
    if (!matched) {
      return undefined;
    }

    const judgeName = matched.judge ?? "default";
    const judge = prepared.preparedJudges[judgeName];
    if (!judge) {
      logger.warn(
        "Judge rule matched but named policy not found — failing closed",
        { organizationId, agentId, hostname, judgeName }
      );
      return undefined;
    }

    return {
      judgeName,
      policy: judge.policy,
      policyHash: judge.policyHash,
      judgeModel: judge.model,
    };
  }
}

/**
 * Translate an agent's `egress`-stage inline guardrails into a
 * {@link JudgePolicyBundle}. Each enabled egress guardrail becomes a named
 * judge (`judges[g.name] = { policy: g.policy, model: g.model }`) and routes
 * every hostname in its `domains` selector through that judge. Returns
 * `undefined` when no egress guardrail declares any domain (common case — no
 * need to occupy a map slot).
 *
 * This is the sole production path into the policy store; it produces the same
 * bundle shape the legacy `network.judged`/`judges`/`egressConfig` path did
 * (see {@link buildPolicyBundle}, kept as the equivalence-test oracle).
 */
export function egressGuardrailsToPolicyBundle(
  guardrails: AgentInlineGuardrail[]
): JudgePolicyBundle | undefined {
  // Normalize first, then dedupe by normalized domain. Equivalent rules
  // (e.g. `*.slack.com` and `.slack.com`, or case variants) collapse to one;
  // last declaration wins, matching the legacy path.
  const dedupedByDomain = new Map<string, JudgedDomainRule>();
  const judges: Record<string, string> = {};
  const judgeModels: Record<string, string> = {};
  for (const g of guardrails) {
    if (!g.enabled || g.stage !== "egress") continue;
    if (typeof g.policy !== "string" || g.policy.trim() === "") continue;
    judges[g.name] = g.policy;
    if (g.model) judgeModels[g.name] = g.model;
    for (const domain of g.domains ?? []) {
      if (!domain) continue;
      const normalized = normalizeDomainPattern(domain);
      dedupedByDomain.set(normalized, { domain: normalized, judge: g.name });
    }
  }
  const judgedDomains = Array.from(dedupedByDomain.values());
  if (judgedDomains.length === 0) return undefined;
  return {
    judgedDomains,
    judges,
    ...(Object.keys(judgeModels).length > 0 ? { judgeModels } : {}),
  };
}

/**
 * Reference (oracle) builder for the LEGACY `network.judged`/`judges`/
 * `egressConfig` source. No longer wired into production — kept so the
 * equivalence test can prove {@link egressGuardrailsToPolicyBundle} resolves
 * identically to the path it replaced. The legacy agent-wide `judgeModel` maps
 * onto every named judge.
 */
export function buildPolicyBundle(input: {
  judgedDomains?: JudgedDomainRule[];
  judges?: Record<string, string>;
  egressConfig?: { judgeModel?: string };
}): JudgePolicyBundle | undefined {
  const dedupedByDomain = new Map<string, JudgedDomainRule>();
  for (const r of input.judgedDomains ?? []) {
    if (!r?.domain) continue;
    const normalized = normalizeDomainPattern(r.domain);
    dedupedByDomain.set(normalized, {
      domain: normalized,
      ...(r.judge ? { judge: r.judge } : {}),
    });
  }
  const judgedDomains = Array.from(dedupedByDomain.values());
  if (judgedDomains.length === 0) return undefined;

  const judges = { ...(input.judges ?? {}) };
  const judgeModels: Record<string, string> = {};
  if (input.egressConfig?.judgeModel) {
    for (const name of Object.keys(judges)) {
      judgeModels[name] = input.egressConfig.judgeModel;
    }
  }
  return {
    judgedDomains,
    judges,
    ...(Object.keys(judgeModels).length > 0 ? { judgeModels } : {}),
  };
}

function prepareBundle(
  organizationId: string,
  agentId: string,
  bundle: JudgePolicyBundle
): PreparedBundle {
  const preparedJudges: Record<string, PreparedJudge> = {};
  for (const [name, rawPolicy] of Object.entries(bundle.judges)) {
    const composed = rawPolicy.trim();
    const model = bundle.judgeModels?.[name];
    preparedJudges[name] = {
      policy: composed,
      policyHash: hashPolicy(organizationId, agentId, name, composed),
      ...(model ? { model } : {}),
    };
  }
  return {
    judgedDomains: bundle.judgedDomains,
    preparedJudges,
  };
}

function findMatchingRule(
  hostname: string,
  rules: JudgedDomainRule[]
): JudgedDomainRule | undefined {
  const normalized = hostname.toLowerCase();

  const exact = rules.find(
    (r) => !r.domain.startsWith(".") && r.domain.toLowerCase() === normalized
  );
  if (exact) return exact;

  // Longer wildcard patterns beat shorter ones (".api.example.com" > ".example.com").
  const wildcards = rules
    .filter((r) => r.domain.startsWith("."))
    .sort((a, b) => b.domain.length - a.domain.length);
  for (const rule of wildcards) {
    const suffix = rule.domain.substring(1).toLowerCase();
    if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
      return rule;
    }
  }
  return undefined;
}

function hashPolicy(
  organizationId: string,
  agentId: string,
  judgeName: string,
  policy: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${organizationId} ${agentId} ${judgeName} ${policy}`)
    .digest("hex")
    .slice(0, 16);
}

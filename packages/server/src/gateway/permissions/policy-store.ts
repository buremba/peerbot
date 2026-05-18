import crypto from "node:crypto";
import type { AgentEgressConfig, DomainJudgeRule } from "@lobu/core";
import { createLogger, normalizeDomainPattern } from "@lobu/core";

const logger = createLogger("policy-store");

/**
 * Per-agent bundle of egress judge policies. Populated by the deployment
 * manager when syncing agent settings; read by the HTTP proxy when a
 * request needs judge evaluation.
 */
interface JudgePolicyBundle {
  /** Domain rules that require a judge verdict. */
  judgedDomains: DomainJudgeRule[];
  /** Named judge policy texts. Key "default" is used when a rule omits `judge`. */
  judges: Record<string, string>;
  /** Operator policy appended to every judge prompt. */
  extraPolicy?: string;
  /** Optional judge model override. */
  judgeModel?: string;
}

/**
 * Resolved judge rule data returned by {@link PolicyStore.resolve}.
 * `policy` is the composed policy text (skill's selected judge + agent's
 * extra policy), `policyHash` keys the verdict cache.
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
}

interface PreparedBundle {
  judgedDomains: DomainJudgeRule[];
  preparedJudges: Record<string, PreparedJudge>;
  judgeModel?: string;
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
      hasExtraPolicy: !!bundle.extraPolicy,
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
      judgeModel: prepared.judgeModel,
    };
  }
}

/**
 * Build a {@link JudgePolicyBundle} from the pieces the deployment manager
 * already holds. Returns `undefined` when the agent has no judged-domain
 * rules (common case — no need to occupy a map slot).
 */
export function buildPolicyBundle(input: {
  judgedDomains?: DomainJudgeRule[];
  judges?: Record<string, string>;
  egressConfig?: AgentEgressConfig;
}): JudgePolicyBundle | undefined {
  // Normalize first, then dedupe by normalized domain. Equivalent rules
  // (e.g. `*.slack.com` and `.slack.com`, or case variants) collapse to one;
  // last declaration wins so operator-level rules can override skill-level.
  const dedupedByDomain = new Map<string, DomainJudgeRule>();
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

  const bundle: JudgePolicyBundle = {
    judgedDomains,
    judges: input.judges ?? {},
  };
  if (input.egressConfig?.extraPolicy) {
    bundle.extraPolicy = input.egressConfig.extraPolicy;
  }
  if (input.egressConfig?.judgeModel) {
    bundle.judgeModel = input.egressConfig.judgeModel;
  }
  return bundle;
}

function prepareBundle(
  organizationId: string,
  agentId: string,
  bundle: JudgePolicyBundle
): PreparedBundle {
  const preparedJudges: Record<string, PreparedJudge> = {};
  for (const [name, rawPolicy] of Object.entries(bundle.judges)) {
    const composed = bundle.extraPolicy
      ? `${rawPolicy.trim()}\n\nAdditional operator policy:\n${bundle.extraPolicy.trim()}`
      : rawPolicy.trim();
    preparedJudges[name] = {
      policy: composed,
      policyHash: hashPolicy(organizationId, agentId, name, composed),
    };
  }
  return {
    judgedDomains: bundle.judgedDomains,
    preparedJudges,
    ...(bundle.judgeModel ? { judgeModel: bundle.judgeModel } : {}),
  };
}

function findMatchingRule(
  hostname: string,
  rules: DomainJudgeRule[]
): DomainJudgeRule | undefined {
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

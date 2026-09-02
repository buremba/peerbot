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
 * (the legacy builder that produced it has no callers left and is gone).
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
 * One judged domain whose judge can never run because an allow grant covers it.
 *
 * `checkDomainAccess` (proxy/http-proxy.ts) consults per-agent allow grants
 * BEFORE the egress judge, so a domain that is both judged and allow-granted
 * returns `allowed: true, source: "grant"` and its judge policy is dead config.
 * The request looks permitted for a reason that has nothing to do with the
 * policy the operator wrote, which is exactly the shape of failure the operator
 * will not notice: the traffic flows.
 */
interface SuppressedJudgedDomain {
  /** Normalized judged pattern from the guardrail's `domains` selector. */
  domain: string;
  /** The guardrail whose judge is suppressed. */
  judge: string;
  /** The normalized allow pattern that shadows it. */
  grant: string;
}

interface SuppressedJudgedDomainOptions {
  /**
   * Whether a `.suffix` allow pattern also covers its root host. The proxy's
   * global allowlist matcher does (`matchesDomainPattern`); the per-agent
   * `GrantStore.hasGrant` does not — it expands a hostname into its exact form
   * plus its wildcard PARENTS, so the root never sees its own wildcard row.
   * Defaults to grant semantics.
   */
  wildcardCoversRoot?: boolean;
}

/**
 * Whether an allow pattern reaches any host a judged pattern covers.
 *
 * Two callers, one predicate: {@link findSuppressedJudgedDomains} uses it to
 * refuse a shadowing agent CONFIG at write time, and the deployment manager's
 * grant reconcile uses it to refuse the shadowing GRANT at dispatch time (a
 * connector-contributed domain never passes through agent config). Both default
 * to grant semantics; only the global-allowlist check passes
 * `wildcardCoversRoot`.
 *
 * A judged `.suffix` covers the root and every subdomain — {@link findMatchingRule},
 * which `PolicyStore.resolve` matches with, treats `normalized === suffix` as a
 * hit. Whether the ALLOW side's wildcard covers the root depends on which
 * matcher enforces it (see {@link SuppressedJudgedDomainOptions}). Two
 * wildcards overlap when either suffix sits under the other.
 */
export function allowReachesJudged(
  judged: string,
  allow: string,
  wildcardCoversRoot = false
): boolean {
  const judgedWild = judged.startsWith(".");
  const allowWild = allow.startsWith(".");
  const j = judgedWild ? judged.slice(1) : judged;
  const a = allowWild ? allow.slice(1) : allow;
  const under = (host: string, suffix: string) => host.endsWith(`.${suffix}`);
  if (!judgedWild && !allowWild) return j === a;
  if (!judgedWild) return (wildcardCoversRoot && j === a) || under(j, a);
  if (!allowWild) return a === j || under(a, j);
  return j === a || under(j, a) || under(a, j);
}

/**
 * Find judged domains that an allow list shadows.
 *
 * Derives the judged set through {@link egressGuardrailsToPolicyBundle} — the
 * same builder the runtime uses — so write-time validation and runtime
 * enforcement cannot disagree about which domains are judged (the enabled /
 * stage / non-empty-policy filtering and the normalization both come along).
 *
 * Reports PARTIAL shadowing too: an exact allow for `example.com` against a
 * judged `.example.com` leaves the root ungoverned while subdomains stay
 * judged, and an allow for `api.example.com` under that same judge carves one
 * host out of it. Each is a narrower hole, but still a hole.
 */
export function findSuppressedJudgedDomains(
  guardrails: AgentInlineGuardrail[],
  allowedDomains: string[] | undefined,
  options: SuppressedJudgedDomainOptions = {}
): SuppressedJudgedDomain[] {
  const bundle = egressGuardrailsToPolicyBundle(guardrails);
  if (!bundle) return [];

  const allowPatterns = (allowedDomains ?? [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => normalizeDomainPattern(d));
  if (allowPatterns.length === 0) return [];

  const wildcardCoversRoot = options.wildcardCoversRoot ?? false;
  const suppressed: SuppressedJudgedDomain[] = [];
  for (const rule of bundle.judgedDomains) {
    const covering = allowPatterns.find((allow) =>
      allowReachesJudged(rule.domain, allow, wildcardCoversRoot)
    );
    if (covering) {
      suppressed.push({
        domain: rule.domain,
        judge: rule.judge ?? "default",
        grant: covering,
      });
    }
  }
  return suppressed;
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

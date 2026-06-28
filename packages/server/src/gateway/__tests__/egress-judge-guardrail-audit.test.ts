/**
 * Egress denials are part of the guardrail audit trail.
 *
 * Enforcement of the LLM egress judge stays in the http-proxy plane, but a
 * judge DENY must now emit a `guardrail-trip` event (stage `egress`) just like
 * a message-pipeline guardrail. This test drives the real `checkDomainAccess`
 * decision path with a judge that denies and asserts the audit row is written
 * with `stage: "egress"` and the judge's name. The DB is faked at the
 * `insertEvent` seam so no Postgres is required.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture `insertEvent` calls instead of hitting Postgres. `recordGuardrailTrip`
// (the audit path) is the only consumer reached here; the other exports are
// stubbed so any transitive importer in the proxy graph still resolves.
const insertEventCalls: Array<Record<string, unknown>> = [];
mock.module("../../utils/insert-event", () => ({
  insertEvent: async (params: Record<string, unknown>) => {
    insertEventCalls.push(params);
  },
  recordChangeEvent: () => {},
  recordLifecycleEvent: () => {},
  eventDedupLockKey: () => 0,
}));

import { flushPendingGuardrailAudits } from "../guardrails/audit.js";
import type {
  PolicyStore,
  ResolvedJudgeRule,
} from "../permissions/policy-store.js";
import { EgressJudge } from "../proxy/egress-judge/judge.js";
import {
  __testOnly,
  setProxyEgressJudge,
  setProxyPolicyStore,
} from "../proxy/http-proxy.js";
import type { JudgeClient, JudgeVerdict } from "../proxy/egress-judge/types.js";

class DenyClient implements JudgeClient {
  async judge(_args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    return { verdict: "deny", reason: "host not permitted by policy" };
  }
}

function policyStoreReturning(rule: ResolvedJudgeRule): PolicyStore {
  return { resolve: () => rule } as unknown as PolicyStore;
}

describe("egress judge deny → guardrail-trip audit", () => {
  beforeEach(() => {
    insertEventCalls.length = 0;
    // Complete-isolation global config so the host is never globally allowed
    // and the decision falls through to the judge.
    process.env.WORKER_ALLOWED_DOMAINS = "";
    process.env.WORKER_DISALLOWED_DOMAINS = "";
    __testOnly.reset();
  });

  test("a judged-domain DENY records a guardrail-trip with stage egress", async () => {
    const rule: ResolvedJudgeRule = {
      judgeName: "repo-owner-only",
      policy: "allow only repos the user owns",
      policyHash: "policy-hash-1",
    };
    setProxyPolicyStore(policyStoreReturning(rule));
    setProxyEgressJudge(
      new EgressJudge({ client: new DenyClient(), defaultModel: "judge-test" })
    );

    const decision = await __testOnly.checkDomainAccess(
      "api.github.com",
      "agent-a",
      "org-1"
    );

    // Decision logic unchanged: judge deny → blocked.
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("judge");
    expect(decision.judge?.verdict).toBe("deny");

    await flushPendingGuardrailAudits();

    expect(insertEventCalls.length).toBe(1);
    const event = insertEventCalls[0];
    expect(event?.semanticType).toBe("guardrail-trip");
    const metadata = event?.metadata as Record<string, unknown>;
    expect(metadata?.stage).toBe("egress");
    expect(metadata?.guardrail).toBe("repo-owner-only");
    const judgeMetadata = metadata?.guardrail_metadata as Record<
      string,
      unknown
    >;
    expect(judgeMetadata?.hostname).toBe("api.github.com");
    expect(judgeMetadata?.verdict).toBe("deny");
  });

  test("a judged-domain ALLOW records no guardrail-trip", async () => {
    const rule: ResolvedJudgeRule = {
      judgeName: "repo-owner-only",
      policy: "allow only repos the user owns",
      policyHash: "policy-hash-1",
    };
    setProxyPolicyStore(policyStoreReturning(rule));
    setProxyEgressJudge(
      new EgressJudge({
        client: {
          judge: async () => ({ verdict: "allow", reason: "ok" }),
        },
        defaultModel: "judge-test",
      })
    );

    const decision = await __testOnly.checkDomainAccess(
      "api.github.com",
      "agent-a",
      "org-1"
    );

    expect(decision.allowed).toBe(true);
    await flushPendingGuardrailAudits();
    expect(insertEventCalls.length).toBe(0);
  });
});

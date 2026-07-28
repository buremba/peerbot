import { describe, expect, mock, test } from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { attachFreshRunJobToken } from "../orchestration/agent-run-input.js";

// Same lazy-ENCRYPTION_KEY convention as worker-token-mint-parity.test.ts.
process.env.ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * A per-run token is minted once, but it is RE-minted on two other paths:
 * durable replay (`attachFreshRunJobToken`) and mid-turn refresh (the
 * `/worker-token/refresh` route). Both rebuild the claim set by hand, so any
 * claim added to the mint without being added to those mappers is silently
 * dropped the moment a run replays or a long turn rotates its token.
 *
 * `nixPackages` is the claim that makes a contributed CLI exist on a remote
 * runtime. Losing it on replay reproduces exactly the failure the package
 * claim was added to fix: an authenticated `gh` that was never installed.
 */
describe("durable replay preserves every signed claim", () => {
  const claims = {
    userId: "u1",
    conversationId: "c1",
    deploymentName: "dep-1",
    channelId: "ch1",
    teamId: "t1",
    agentId: "a1",
    organizationId: "org1",
    connectionId: "conn1",
    platform: "slack",
    source: "chat",
    runId: 7,
    messageId: "m1",
    runtimeProviderId: "vercel",
    sandboxId: "sb1",
    allowedDomains: ["api.github.com"],
    deniedDomains: ["evil.example.com"],
    nixPackages: ["gh"],
  };

  test("the PERSISTED claim set carries nixPackages, not just the remint", async () => {
    // `durableClaims` is a hand-written mapper feeding
    // agent_run_input.token_claims. A claim the mint signs but that mapper
    // omits is lost at the DATABASE boundary, before attachFreshRunJobToken
    // ever sees it — so capture what recordAgentRunInput actually writes.
    let persisted: Record<string, unknown> | undefined;
    const sql = Object.assign(
      async (..._args: unknown[]) => {
        return [];
      },
      {
        json: (value: Record<string, unknown>) => {
          // The second json() call in recordAgentRunInput is the claim set.
          if (value && "userId" in value) persisted = value;
          return value;
        },
      },
    );
    mock.module("../../db/client.js", () => ({
      getDb: () => sql,
      pgTextArray: (v: string[]) => v,
    }));

    const { recordAgentRunInput } = await import(
      "../orchestration/agent-run-input.js"
    );
    const runJobToken = generateWorkerToken(
      claims.userId,
      claims.conversationId,
      claims.deploymentName,
      claims as never,
    );
    await recordAgentRunInput(
      {
        ...claims,
        runJobToken,
      } as never,
      claims.deploymentName,
    );

    expect(persisted?.allowedDomains).toEqual(["api.github.com"]);
    expect(persisted?.nixPackages).toEqual(["gh"]);
  });

  test("attachFreshRunJobToken carries nixPackages across a replay remint", () => {
    const replayed = attachFreshRunJobToken({
      payload: { runId: 7, messageId: "m1" } as never,
      tokenClaims: claims as never,
    });

    const decoded = verifyWorkerToken(replayed.runJobToken as string);

    // The egress claims already survive replay; the package claim must too.
    // Without it the sandbox gets the domain grants for a binary it never
    // installed — the asymmetry this branch exists to close.
    expect(decoded?.allowedDomains).toEqual(["api.github.com"]);
    expect(decoded?.nixPackages).toEqual(["gh"]);
  });

  test("a refresh-shaped remint keeps nixPackages alongside the egress claims", () => {
    // Mirrors the claim set the /worker-token/refresh route rebuilds. Minting
    // through the same helper the route calls pins the contract without
    // booting the gateway.
    const refreshed = generateWorkerToken(
      claims.userId,
      claims.conversationId,
      claims.deploymentName,
      {
        channelId: claims.channelId,
        teamId: claims.teamId,
        agentId: claims.agentId,
        organizationId: claims.organizationId,
        connectionId: claims.connectionId,
        platform: claims.platform,
        source: claims.source,
        runId: claims.runId,
        messageId: claims.messageId,
        runtimeProviderId: claims.runtimeProviderId,
        sandboxId: claims.sandboxId,
        allowedDomains: claims.allowedDomains,
        deniedDomains: claims.deniedDomains,
        nixPackages: claims.nixPackages,
      } as never,
    );

    const decoded = verifyWorkerToken(refreshed);
    expect(decoded?.nixPackages).toEqual(["gh"]);
  });
});

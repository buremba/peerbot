import { describe, expect, test } from "bun:test";
import { type WorkerTokenData, verifyWorkerToken } from "@lobu/core";
import { buildDeploymentWorkerToken } from "../orchestration/base-deployment-manager.js";
import { buildRunJobToken } from "../orchestration/message-consumer.js";
import { assertRoutableInteraction } from "../interactions.js";

// Token mint/verify round-trips through encrypt(), which reads ENCRYPTION_KEY
// lazily at call time. Provide a deterministic test key (CI's integration job
// sets it; this keeps the file runnable standalone, matching repo convention).
process.env.ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Stronger regression than `runjobtoken-connectionid.test.ts`. That test pinned
 * the contract by calling `generateWorkerToken` directly with connectionId — it
 * never exercised the actual MINT, which is where the #1274 P0 lived
 * (MessageConsumer minted the per-run token WITHOUT connectionId, so every
 * chat `ask_user` 500'd at `assertRoutableInteraction`).
 *
 * Here we drive the REAL mint functions (`buildRunJobToken`,
 * `buildDeploymentWorkerToken`) — the exact code the gateway runs — and assert
 * claim PARITY against everything the verified-worker-token consumers read:
 *
 *   - `assertRoutableInteraction` (gateway/interactions.ts) → connectionId
 *   - interaction route (routes/internal/interactions.ts)   → source, platform,
 *     teamId, channelId, conversationId, userId
 *   - files route   → connectionId, platform, teamId
 *   - images/audio  → agentId
 *   - device-auth   → organizationId
 *   - snapshot      → runId (per-run token only)
 *
 * The two functions are the worker's PRIMARY and FALLBACK gateway auth
 * (`session-runner`: `runJobToken || WORKER_TOKEN`). A claim a consumer needs
 * but a mint omits is a latent connectionId-class bug. The CONSUMER_REQUIRED
 * lists below are the canary: add a consumer that reads a new claim, add it
 * here, and the next omitted-claim mint fails RED in CI instead of in prod.
 */

const CONN = "cfa916c95eb64939";

/** Claims both primary-auth mints must carry for chat-platform routing. */
const SHARED_REQUIRED: Array<keyof WorkerTokenData> = [
  "userId",
  "conversationId",
  "channelId",
  "teamId",
  "agentId",
  "organizationId",
  "platform",
  "connectionId",
  // Headless run origin — interaction cards stamped headless skip the
  // SSE-owner gate; absent → owner-gated card dead-letters on a headless run.
  "source",
];

describe("worker-token mint parity (real mint, not generateWorkerToken)", () => {
  const baseArgs = {
    userId: "U_USER",
    conversationId: "slack:DM:123.456",
    deploymentName: "dep-1",
    channelId: "slack:DM",
    teamId: "T_TEAM",
    agentId: "crm",
    organizationId: "org_lobucrm",
    platform: "slack",
    platformMetadata: { connectionId: CONN, source: "watcher-run" },
  };

  test("buildRunJobToken carries EVERY consumer-required claim", () => {
    const token = buildRunJobToken({ ...baseArgs, runId: 42 });
    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token as string);
    expect(decoded).not.toBeNull();

    for (const claim of SHARED_REQUIRED) {
      expect(
        decoded?.[claim],
        `runJobToken omitted "${claim}" — a consumer reads it off the verified worker token; this is exactly the connectionId-class bug (#1274)`
      ).toBeDefined();
    }
    // Per-run token is run-scoped (snapshot route requires runId equality).
    expect(decoded?.runId).toBe(42);
    expect(decoded?.connectionId).toBe(CONN);
    expect(decoded?.source).toBe("watcher-run");

    // The route does exactly this with the decoded context — must not throw.
    expect(() =>
      assertRoutableInteraction(decoded?.connectionId, "slack", "question")
    ).not.toThrow();
  });

  test("buildDeploymentWorkerToken (fallback) carries the same shared claims", () => {
    const token = buildDeploymentWorkerToken(baseArgs);
    const decoded = verifyWorkerToken(token);
    expect(decoded).not.toBeNull();

    for (const claim of SHARED_REQUIRED) {
      expect(
        decoded?.[claim],
        `WORKER_TOKEN omitted "${claim}" — a worker that falls back to this deployment-lifetime token loses it (connectionId-class bug, #1274)`
      ).toBeDefined();
    }
    expect(decoded?.connectionId).toBe(CONN);
    // The omitted-claim divergence this audit fixed: WORKER_TOKEN now carries
    // `source` so headless cards aren't dead-lettered on the fallback path.
    expect(decoded?.source).toBe("watcher-run");
    expect(() =>
      assertRoutableInteraction(decoded?.connectionId, "slack", "question")
    ).not.toThrow();
  });

  test("PARITY: both mints set the identical set of shared claims", () => {
    const runJob = verifyWorkerToken(
      buildRunJobToken({ ...baseArgs, runId: 7 }) as string
    );
    const deployment = verifyWorkerToken(buildDeploymentWorkerToken(baseArgs));

    for (const claim of SHARED_REQUIRED) {
      const inRunJob = runJob?.[claim] !== undefined;
      const inDeployment = deployment?.[claim] !== undefined;
      expect(
        inRunJob,
        `claim "${claim}" present on WORKER_TOKEN but missing on runJobToken — divergence`
      ).toBe(inDeployment);
    }
  });

  test("the shipped bug reproduces: a chat token WITHOUT connectionId is rejected", () => {
    // Mint via the real path but with no connectionId in platformMetadata —
    // this is the state MessageConsumer produced before #1274.
    const token = buildRunJobToken({
      ...baseArgs,
      platformMetadata: { source: "watcher-run" }, // connectionId omitted
      runId: 42,
    });
    const decoded = verifyWorkerToken(token as string);
    expect(decoded?.connectionId).toBeUndefined();
    expect(() =>
      assertRoutableInteraction(decoded?.connectionId, "slack", "question")
    ).toThrow();
  });

  test("legacy direct-enqueue (no runId) mints no per-run token", () => {
    expect(buildRunJobToken(baseArgs)).toBeUndefined();
  });
});

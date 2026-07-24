/**
 * resolvePinnedSelection — the conversation-scoped runtime resolver both worker-
 * token mints call. Verifies the load-bearing pin semantics against the test DB:
 * a conversation's runtime realm is frozen on its first turn (first-writer-wins)
 * and is IMMUTABLE thereafter, so repointing the agent to a different sandbox
 * never migrates an existing conversation's sandbox. Runs against whichever
 * backend globalSetup selected (embedded PG with `bun run test`, real PG with
 * DATABASE_URL set).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import {
  createTestAgent,
  createTestOrganization,
} from "../../../__tests__/setup/test-fixtures";
import { createSandbox, resolvePinnedSelection } from "../sandbox-store";

const PLATFORM = "web";

/** Seed an unpinned conversations row for the given agent. */
async function seedConversation(
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO public.conversations
      (organization_id, agent_id, platform, conversation_id, kind, last_activity_at)
    VALUES (${organizationId}, ${agentId}, ${PLATFORM}, ${conversationId}, 'owned', now())
  `;
}

/** Point an agent at a sandbox (or clear it with null). */
async function setAgentSandbox(
  organizationId: string,
  agentId: string,
  sandboxId: string | null
): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE agents SET sandbox_id = ${sandboxId}
    WHERE id = ${agentId} AND organization_id = ${organizationId}
  `;
}

async function readPin(
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<{ mode: string | null; provider: string | null }> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT sandbox_mode, sandbox_provider_id
    FROM public.conversations
    WHERE organization_id = ${organizationId} AND agent_id = ${agentId}
      AND platform = ${PLATFORM} AND conversation_id = ${conversationId}
  `) as Array<{ sandbox_mode: string | null; sandbox_provider_id: string | null }>;
  return {
    mode: rows[0]?.sandbox_mode ?? null,
    provider: rows[0]?.sandbox_provider_id ?? null,
  };
}

describe("resolvePinnedSelection", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    const sql = getTestDb();
    await sql`TRUNCATE conversations, sandboxes CASCADE`;
  });

  it("pins a provider sandbox on the first turn and returns it", async () => {
    const org = await createTestOrganization({ name: "Pin Provider Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    const sandbox = await createSandbox(org.id, {
      name: "vercel-prod",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandbox.id);
    await seedConversation(org.id, agent.agentId, "conv-provider");

    const sel = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-provider",
    });

    expect(sel.runtimeProviderId).toBe("vercel");
    expect(sel.sandboxId).toBe(sandbox.id);
    // The row is now frozen to 'provider'.
    expect(await readPin(org.id, agent.agentId, "conv-provider")).toEqual({
      mode: "provider",
      provider: "vercel",
    });
  });

  it("pins 'builtin' (local just-bash) when the agent has no sandbox", async () => {
    const org = await createTestOrganization({ name: "Pin Builtin Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    await seedConversation(org.id, agent.agentId, "conv-builtin");

    const sel = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-builtin",
    });

    // No provider → local just-bash.
    expect(sel.runtimeProviderId).toBeUndefined();
    expect(await readPin(org.id, agent.agentId, "conv-builtin")).toEqual({
      mode: "builtin",
      provider: null,
    });
  });

  it("never materializes a conversations row for a watcher run (honors the exclusion)", async () => {
    // Watcher runs are ephemeral and have NO conversations row (message-consumer
    // excludes them from the dual-write). The resolver must honor the same
    // exclusion — resolve live, and NOT upsert a listing row (which would pollute
    // the sidebar and break the watcher no-row contract).
    const org = await createTestOrganization({ name: "Pin Watcher Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    const sandbox = await createSandbox(org.id, {
      name: "vercel-watcher",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandbox.id);

    const watcherConvId = `${agent.agentId}_watcher_1_run_42`;
    const sel = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: watcherConvId,
    });

    // Live selection returned (the agent's current provider) …
    expect(sel.runtimeProviderId).toBe("vercel");
    // … but NO row was created for the watcher conversation id.
    const sql = getTestDb();
    const rows = (await sql`
      SELECT 1 FROM public.conversations
      WHERE organization_id = ${org.id} AND agent_id = ${agent.agentId}
        AND conversation_id = ${watcherConvId}
    `) as unknown[];
    expect(rows.length).toBe(0);
  });

  it("converges under a concurrent first-turn race (both callers agree on one pin)", async () => {
    // Two simultaneous first turns on the same absent conversation: the upsert's
    // first-writer-wins guard must yield ONE pin, and both callers must return it
    // (no split-brain where one runs provider and the other builtin).
    const org = await createTestOrganization({ name: "Pin Race Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    const sandbox = await createSandbox(org.id, {
      name: "vercel-race",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandbox.id);

    const call = () =>
      resolvePinnedSelection({
        organizationId: org.id,
        agentId: agent.agentId,
        platform: PLATFORM,
        conversationId: "conv-race",
      });
    const [a, b] = await Promise.all([call(), call()]);

    // Both agree, and both resolved the same provider (no split-brain).
    expect(a.runtimeProviderId).toBe("vercel");
    expect(b.runtimeProviderId).toBe("vercel");
    expect(a.sandboxId).toBe(sandbox.id);
    expect(b.sandboxId).toBe(sandbox.id);
    expect(await readPin(org.id, agent.agentId, "conv-race")).toEqual({
      mode: "provider",
      provider: "vercel",
    });
  });

  it("durably pins even when the conversations row is ABSENT (best-effort dual-write hasn't landed)", async () => {
    // No seedConversation — the row does not exist yet. The resolver must CREATE
    // it with the pin (upsert), so the realm is durable from turn 1 and a later
    // turn can't move it. Without this, an absent row → unpinned turn → a repoint
    // before the dual-write lands would migrate the conversation's realm.
    const org = await createTestOrganization({ name: "Pin Absent-Row Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    const sandbox = await createSandbox(org.id, {
      name: "vercel-absent",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandbox.id);

    const sel = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-absent",
    });

    expect(sel.runtimeProviderId).toBe("vercel");
    // The row was created AND pinned in one shot.
    expect(await readPin(org.id, agent.agentId, "conv-absent")).toEqual({
      mode: "provider",
      provider: "vercel",
    });

    // Repoint, then a later turn: still the original pin (immutability holds even
    // though the row was born from the pin path, not the dual-write).
    const sandboxB = await createSandbox(org.id, {
      name: "vercel-absent-b",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandboxB.id);
    const second = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-absent",
    });
    expect(second.sandboxId).toBe(sandbox.id);
    expect(second.sandboxId).not.toBe(sandboxB.id);
  });

  it("classifies the dispatch platform: 'api' pins the stored 'web' row", async () => {
    // The live dual-write stores api conversations under platform 'web'
    // (classifyConversation). resolvePinnedSelection must classify identically —
    // called with the raw dispatch platform 'api', it must still hit the 'web'
    // row, else web/api conversations would never persist or read their pin.
    const org = await createTestOrganization({ name: "Pin Api Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    // Seed the row exactly as the dual-write would: stored platform 'web'.
    await seedConversation(org.id, agent.agentId, "conv-api");

    const sel = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: "api", // ← RAW dispatch platform, not the stored 'web'
      conversationId: "conv-api",
    });

    expect(sel.runtimeProviderId).toBeUndefined();
    // The 'web' row (readPin uses PLATFORM='web') got pinned — proving the
    // 'api' → 'web' classification hit the right row.
    expect(await readPin(org.id, agent.agentId, "conv-api")).toEqual({
      mode: "builtin",
      provider: null,
    });
  });

  it("is IMMUTABLE: repointing the agent's sandbox never moves an existing conversation's pin", async () => {
    const org = await createTestOrganization({ name: "Pin Immutable Org" });
    const agent = await createTestAgent({ organizationId: org.id });
    const sandboxA = await createSandbox(org.id, {
      name: "vercel-a",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandboxA.id);
    await seedConversation(org.id, agent.agentId, "conv-immutable");

    // First turn pins to sandboxA's provider.
    const first = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-immutable",
    });
    expect(first.runtimeProviderId).toBe("vercel");
    expect(first.sandboxId).toBe(sandboxA.id);

    // Operator repoints the agent to a DIFFERENT environment (distinct id — the
    // pin freezes the sandboxId, so a same-provider repoint still exercises
    // immutability).
    const sandboxB = await createSandbox(org.id, {
      name: "vercel-b",
      providerKind: "vercel",
    });
    await setAgentSandbox(org.id, agent.agentId, sandboxB.id);

    // A later turn on the SAME conversation still resolves the ORIGINAL pin —
    // the repoint does not migrate this conversation's sandbox realm (its
    // sandboxId stays sandboxA, not the newly-pointed sandboxB).
    const second = await resolvePinnedSelection({
      organizationId: org.id,
      agentId: agent.agentId,
      platform: PLATFORM,
      conversationId: "conv-immutable",
    });
    expect(second.runtimeProviderId).toBe("vercel");
    expect(second.sandboxId).toBe(sandboxA.id);
    expect(second.sandboxId).not.toBe(sandboxB.id);
    expect(await readPin(org.id, agent.agentId, "conv-immutable")).toEqual({
      mode: "provider",
      provider: "vercel",
    });
  });
});

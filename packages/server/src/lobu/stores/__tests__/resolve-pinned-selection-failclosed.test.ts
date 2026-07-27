/**
 * resolvePinnedSelection fail-closed path — Vitest unit test (no DB). When the
 * pin read AND the guarded upsert/reread throw (a DB outage) for an existing
 * conversation, the resolver must NOT return ANY guessed realm — not the agent's
 * current (possibly repointed) sandbox, and not builtin either (builtin is
 * still "not the pinned realm"). The only correct action is to THROW, which the
 * dispatch caller turns into a queue retry; the turn re-runs once the DB recovers
 * and reads/pins the real realm. Reproduces codex round-5/6's finding.
 *
 * Uses vi.doMock + a fresh module registry (vi.resetModules) inside the test and
 * dynamic-imports the resolver AFTER the mocks are registered, so the mock is
 * scoped to this test and does not leak into (or get clobbered by) the DB-backed
 * pin suite when both run in the same vitest worker. Lives in the vitest-owned
 * stores/__tests__ tree so scripts/check-test-runner-coverage.mjs stays green.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../../db/client.js");
  vi.doUnmock("../../../gateway/services/conversations-store.js");
});

describe("resolvePinnedSelection — fail closed on total DB failure", () => {
  it("THROWS (→ queue retry) — never returns a guessed realm — when the pin read and upsert both fail", async () => {
    vi.resetModules();
    // The agents/sandboxes lookup RESOLVES (sbx-b, a repointed provider sandbox),
    // but every conversations query THROWS — codex's exact repro.
    vi.doMock("../../../db/client.js", () => ({
      getDb: () => (strings: TemplateStringsArray, ..._v: unknown[]) => {
        const q = strings.join(" ");
        if (q.includes("FROM agents")) {
          return Promise.resolve([
            { sandbox_id: "sbx-b", provider_kind: "vercel" },
          ]);
        }
        return Promise.reject(new Error("db down"));
      },
    }));
    vi.doMock("../../../gateway/services/conversations-store.js", () => ({
      classifyConversation: () => ({ kind: "owned", storedPlatform: "web" }),
      isWatcherConversationId: () => false,
      // An ordinary user conversation, so it does materialize a listing row —
      // this test is about the pin read failing, not about listing suppression.
      shouldMaterializeListingRow: () => true,
    }));

    const { resolvePinnedSelection } = await import("../sandbox-store.js");

    // Must throw (not return sbx-b, not return builtin) so the turn is retried.
    await expect(
      resolvePinnedSelection({
        organizationId: "org-1",
        agentId: "agent-1",
        platform: "web",
        conversationId: "conv-outage",
      })
    ).rejects.toThrow(/db down/);
  });
});

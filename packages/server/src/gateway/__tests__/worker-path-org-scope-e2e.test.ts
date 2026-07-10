/**
 * End-to-end proof (real Postgres store, no mocks) that the worker-dispatch
 * model-resolution path resolves the CALLER's org when a shared agent id
 * (lobu-builder) exists in multiple orgs.
 *
 * This reproduces the original Slack-bot bug condition: two orgs both own an
 * agent id `lobu-builder`, each with a different `models` list. The worker
 * path runs with NO ambient orgContext. Before the #1779 fix, `resolveAgentOptions`
 * fell to an id-only read and returned an arbitrary org's model (the Gemini/Claude
 * 404). This drives the real resolver against the real store and asserts the
 * right model comes back — and that a deliberately unscoped read returns the wrong
 * one (the bug it fixes).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const AGENT = "lobu-builder";
const ORG_CLAUDE = "org-claude"; // the org an unscoped read returns first
const ORG_GEMINI = "org-gemini"; // install 10's org in the real incident

describe("worker-path org scope (real store, shared agent id)", () => {
  let store: AgentSettingsStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore(createPostgresAgentConfigStore());

    // Seed the SAME agent id in two orgs with different models lists. Order
    // matters: org-claude is created first so an unscoped `WHERE id = $agentId`
    // (no ORDER BY) tends to return it — the wrong row for a gemini install.
    await seedAgentRow(AGENT, { organizationId: ORG_CLAUDE });
    await seedAgentRow(AGENT, { organizationId: ORG_GEMINI });
    await orgContext.run({ organizationId: ORG_CLAUDE }, () =>
      store.saveSettings(AGENT, {
        models: ["claude/claude-sonnet-4-6"],
      } as any),
    );
    await orgContext.run({ organizationId: ORG_GEMINI }, () =>
      store.saveSettings(AGENT, {
        models: ["gemini/gemini-2.5-flash"],
      } as any),
    );
  });

  test("resolveAgentOptions resolves the gemini org's model on the worker path (no ambient org)", async () => {
    // Exactly how the worker-dispatch path calls it: no ambient orgContext, org
    // passed as the explicit 4th arg. This is the fixed path.
    const resolved = await resolveAgentOptions(AGENT, {}, store, ORG_GEMINI);

    expect(resolved.model).toBe("gemini/gemini-2.5-flash");
    // Not the other org's Claude model — the mangled `gemini/claude/...` 404.
    expect(resolved.model).not.toBe("claude/claude-sonnet-4-6");
  });

  test("the OLD unscoped read returns the WRONG org's model (the bug this fixes)", async () => {
    // Simulate the pre-fix behavior: read with no org and no ambient context.
    // The store falls to the id-only query and returns an arbitrary org's row.
    const unscoped = await store.getSettings(AGENT);

    // Whatever it returns, it is NOT reliably the gemini org — demonstrating why
    // the explicit org scope is required. In this seeding it returns claude's.
    expect(unscoped?.models?.[0]).toBe("claude/claude-sonnet-4-6");
  });

  test("each org resolves its own model independently", async () => {
    const gemini = await resolveAgentOptions(AGENT, {}, store, ORG_GEMINI);
    const claude = await resolveAgentOptions(AGENT, {}, store, ORG_CLAUDE);

    expect(gemini.model).toBe("gemini/gemini-2.5-flash");
    expect(claude.model).toBe("claude/claude-sonnet-4-6");
  });
});

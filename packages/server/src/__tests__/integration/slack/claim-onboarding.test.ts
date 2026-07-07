/**
 * Integration tests for `gateway/connections/slack-claim-onboarding.ts`.
 *
 * The post-claim onboarding step: after a pending Slack install is claimed into
 * an org, the org's Builder agent is auto-linked to the installer's bot DM, and
 * the one-time welcome DM fires. Covers the happy path (DM opened + builder
 * binding created + welcome sent), idempotency (re-run doesn't double-send the
 * welcome), and the no-installer skip (no DM to auto-link).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILDER_AGENT_ID,
} from "../../../auth/builder-provisioning";
import { getDb } from "../../../db/client";
import { autoLinkBuilderAndWelcome } from "../../../gateway/connections/slack-claim-onboarding";
import type { SlackWebApi } from "../../../gateway/connections/slack-web";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  createTestAgent,
  createTestOrganization,
  insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEAM = "T-CLAIM-ONB";
const INSTALLER = "U-INSTALLER";
const DM_CHANNEL = "D-INSTALLER";
const BOT_TOKEN = "xoxb-onboarding";

/** A SlackWebApi stub that records openDm/postMessage. */
function makeWeb() {
  const openDm = vi.fn(async () => DM_CHANNEL);
  const postMessage = vi.fn(async () => undefined);
  return {
    openDm,
    postMessage,
    conversationMembers: async () => [],
    conversationInfo: async () => ({ name: null, isPrivate: false }),
    usersInfo: async () => ({ isAdmin: false, isOwner: false }),
    revokeToken: async () => true,
    authTest: async () => ({ teamId: TEAM }),
    exchangeOAuthCode: async () => {
      throw new Error("not used");
    },
  } as unknown as SlackWebApi & {
    openDm: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
}

/** A secret store that resolves any ref to the installed bot token. */
function makeSecretStore() {
  return {
    get: async () => BOT_TOKEN,
    put: async (name: string) => `secret://${encodeURIComponent(name)}`,
    delete: async () => undefined,
    list: async () => [],
    // Registry shape: resolveSecretValue reads `.get`; the scheme resolver
    // proxies to the same store.
  } as any;
}

async function seedClaimedWorkspace(orgId: string): Promise<void> {
  const sql = getTestDb();
  // The org's Builder agent + the system-agent pointer, mirroring
  // ensureBuilderAgent's end state so autoLink binds to it.
  await createTestAgent({
    organizationId: orgId,
    agentId: BUILDER_AGENT_ID,
    name: "Builder",
  });
  await sql`
    UPDATE "organization" SET system_agent_id = ${BUILDER_AGENT_ID}
    WHERE id = ${orgId}
  `;
  // The active managed Slack connection (the claim's projection). Its slug is
  // the slackinst- external id; config carries the bot-token secret ref.
  await insertChatConnectionRow({
    id: `slackinst-${TEAM}`,
    organizationId: orgId,
    platform: "slack",
    status: "active",
    credentialMode: "managed",
    config: { botToken: "secret://installations/x/botToken" },
    metadata: { teamId: TEAM, teamName: "Acme" },
  });
  // The active app_installations row the welcome marker needs (installer id set,
  // welcome_dm_sent unset).
  await sql`
    INSERT INTO app_installations
      (organization_id, provider, provider_instance, provider_app_id,
       external_tenant_id, status, metadata)
    VALUES
      (${orgId}, 'slack', 'cloud', 'cloud', ${TEAM}, 'active',
       ${sql.json({
         external_id: `slackinst-${TEAM}`,
         installer_user_id: INSTALLER,
         config: { platform: "slack", botToken: "secret://installations/x/botToken" },
       })})
  `;
}

async function bindingsForBuilder(orgId: string): Promise<
  Array<{ agent_id: string; channel_id: string; platform: string }>
> {
  return (await getTestDb()`
    SELECT agent_id, channel_id, platform
    FROM agent_channel_bindings
    WHERE organization_id = ${orgId} AND agent_id = ${BUILDER_AGENT_ID}
  `) as Array<{ agent_id: string; channel_id: string; platform: string }>;
}

describe("autoLinkBuilderAndWelcome (post-claim Slack onboarding)", () => {
  let orgId: string;

  beforeEach(async () => {
    const org = await createTestOrganization({ name: "Acme" });
    orgId = org.id;
    await seedClaimedWorkspace(orgId);
  });

  afterEach(async () => {
    await getTestDb()`DELETE FROM app_installations WHERE external_tenant_id = ${TEAM}`;
    await cleanupTestDatabase();
  });

  it("auto-links the Builder to the installer DM and sends the welcome", async () => {
    const web = makeWeb();
    await autoLinkBuilderAndWelcome({
      teamId: TEAM,
      organizationId: orgId,
      installerUserId: INSTALLER,
      secretStore: makeSecretStore(),
      web,
    });

    // DM opened with the installer, using the resolved bot token.
    expect(web.openDm).toHaveBeenCalled();
    expect(web.openDm.mock.calls[0]?.[0]).toBe(BOT_TOKEN);
    expect(web.openDm.mock.calls[0]?.[1]).toBe(INSTALLER);

    // A binding to the Builder on the canonical DM channel key exists.
    const bindings = await bindingsForBuilder(orgId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.channel_id).toBe(`slack:${DM_CHANNEL}`);
    expect(bindings[0]?.platform).toBe("slack");

    // Welcome DM posted (openDm called at least twice: link-bind + welcome, or
    // the welcome path reuses its own openDm — either way postMessage fired).
    expect(web.postMessage).toHaveBeenCalled();
  });

  it("is idempotent — a second run re-binds harmlessly and sends no second welcome", async () => {
    const web1 = makeWeb();
    await autoLinkBuilderAndWelcome({
      teamId: TEAM,
      organizationId: orgId,
      installerUserId: INSTALLER,
      secretStore: makeSecretStore(),
      web: web1,
    });
    const welcomePostsFirst = web1.postMessage.mock.calls.length;
    expect(welcomePostsFirst).toBeGreaterThanOrEqual(1);

    const web2 = makeWeb();
    await autoLinkBuilderAndWelcome({
      teamId: TEAM,
      organizationId: orgId,
      installerUserId: INSTALLER,
      secretStore: makeSecretStore(),
      web: web2,
    });

    // Still exactly one binding (upsert on the same DM channel).
    const bindings = await bindingsForBuilder(orgId);
    expect(bindings).toHaveLength(1);

    // The welcome marker was claimed on the first run — the second run's
    // welcome is a no-op. The DM auto-link still opens a DM to (re)bind, so we
    // assert the WELCOME text isn't re-posted by checking the post count dropped
    // to only the (possible) link-side, never the welcome again. Simplest
    // invariant: no NEW welcome post beyond the link open.
    // Since the auto-link path itself doesn't postMessage (only binds), a second
    // run posts nothing.
    expect(web2.postMessage).not.toHaveBeenCalled();
  });

  it("skips the DM auto-link (no builder binding) when there's no installer id, without throwing", async () => {
    // A claim with no installer identity: strip installer_user_id from the
    // install row so BOTH halves have nothing to reach — no auto-link binding
    // and (the welcome marker requires installer_user_id) no welcome DM.
    await getTestDb()`
      UPDATE app_installations
      SET metadata = (metadata::jsonb - 'installer_user_id')::json
      WHERE external_tenant_id = ${TEAM}
    `;
    const web = makeWeb();
    await autoLinkBuilderAndWelcome({
      teamId: TEAM,
      organizationId: orgId,
      installerUserId: null,
      secretStore: makeSecretStore(),
      web,
    });
    // No Builder binding was created (the auto-link needs an installer to DM).
    const bindings = await bindingsForBuilder(orgId);
    expect(bindings).toHaveLength(0);
    // And no welcome DM (the marker precondition installer_user_id is absent).
    expect(web.openDm).not.toHaveBeenCalled();
    expect(web.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * Local end-to-end of the DM `/lobu link <code>` chain against a real Postgres:
 * a plain message `/lobu link <code>` (how it arrives in an AI-app DM) →
 * CommandDispatcher.tryHandleSlashText unwraps the `/lobu` wrapper → the real
 * built-in `link` command → consumePreviewClaim → the binding row is written and
 * the claim is consumed. No mocks for the consume/bind path — only the registry
 * deps the `link` handler doesn't touch are stubbed.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { CommandRegistry } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { registerBuiltInCommands } from "../commands/built-in-commands.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import { ensureDbForGatewayTests, seedAgentRow } from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

// Mirrors codeHash() in preview/slack.ts (sha256 of the trimmed, lowercased code).
function codeHash(code: string): string {
	return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

describe("DM /lobu link <code> — real consume→bind chain", () => {
  test("a plain-message `/lobu link <code>` redeems the claim and writes the binding", async () => {
    const sql = getDb();
    const code = `crm-${Date.now().toString(36).toUpperCase()}`;
    const agentId = `agent-e2e-${Date.now()}`;
    const organizationId = `org-e2e-${Date.now()}`;
    const channelId = `D${Date.now().toString(36)}`;
    const canonical = `slack:${channelId}`;

    // The binding has an FK on (organization_id, agent_id), so the agent must
    // exist (seedAgentRow also creates the organization row).
    await seedAgentRow(agentId, { organizationId });
		const [connection] = await sql`
		INSERT INTO connections (
			organization_id, connector_key, slug, display_name, status,
			credential_mode, config
		)
		VALUES (
			${organizationId}, 'slack', ${`agentconn-${agentId}`}, 'Slack',
			'active', 'byo', '{}'
		)
		RETURNING id
	`;

    // Seed the preview claim exactly as createPreviewClaim would.
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        ${codeHash(code)},
        'slack-preview-claim',
        ${sql.json({
          organizationId,
          agentId,
          createdBy: null,
          allowedSurfaces: ["dm", "channel"],
          createdAt: Date.now(),
        })},
        now() + interval '1 hour'
      )
    `;

    try {
      // Real registry + real built-in commands. agentSettingsStore is unused by
      // the `link` handler, so a stub is fine.
      const registry = new CommandRegistry();
      registerBuiltInCommands(registry, {
        agentSettingsStore: {} as never,
      });
      const dispatcher = new CommandDispatcher({
        registry,
				channelBindingService: {
					getBindingForConnection: mock(async () => null),
				} as never,
      });

      const replies: string[] = [];
      const handled = await dispatcher.tryHandleSlashText(
        `/lobu link ${code}`,
        {
          platform: "slack",
          userId: "U_E2E",
          channelId,
          teamId: "T_E2E",
					connectionId: agentId,
					organizationId,
          isGroup: false,
          reply: async (content: unknown) => {
            replies.push(
							typeof content === "string" ? content : JSON.stringify(content),
            );
          },
				},
      );

      expect(handled).toBe(true);
      expect(replies.join("\n")).toContain("Linked this chat to agent");
      expect(replies.join("\n")).toContain(agentId);

      // Claim consumed (one-time use).
      const remaining = await sql`
        SELECT 1 FROM oauth_states WHERE id = ${codeHash(code)}
      `;
      expect(remaining.length).toBe(0);

      // Binding written under the canonical slack:<id> key, scoped to team+agent.
      const binding = (await sql`
        SELECT agent_id, organization_id, team_id
        FROM agent_channel_bindings
        WHERE platform = 'slack'
          AND channel_id = ${canonical}
          AND team_id = 'T_E2E'
      `) as Array<{
        agent_id: string;
        organization_id: string;
        team_id: string;
      }>;
      expect(binding.length).toBe(1);
      expect(binding[0]?.agent_id).toBe(agentId);
      expect(binding[0]?.organization_id).toBe(organizationId);
    } finally {
      await sql`DELETE FROM agent_channel_bindings WHERE channel_id = ${canonical}`;
			await sql`DELETE FROM connections WHERE id = ${connection.id}`;
      await sql`DELETE FROM oauth_states WHERE id = ${codeHash(code)}`;
      await sql`DELETE FROM agents WHERE id = ${agentId} AND organization_id = ${organizationId}`;
      await sql`DELETE FROM organization WHERE id = ${organizationId}`;
    }
  });
});

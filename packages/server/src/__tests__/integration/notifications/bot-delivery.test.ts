/**
 * Integration test for the notification → bot-connection delivery path.
 *
 * Exercises `resolveBotDeliveryTargets` against a real DB: it JOINs the org's
 * active chat connections to their Behavior subscriptions and returns the channel(s)
 * each notification should post to. This is the path that was a silent no-op
 * after #846 removed the HTTP endpoints the old implementation called.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBotDeliveryTargets } from "../../../notifications/service";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestBehaviorSubscription } from "../../setup/behavior-subscriptions";
import {
	addUserToOrganization,
  createTestAgent,
  createTestOrganization,
	createTestUser,
  insertChatConnectionRow,
} from "../../setup/test-fixtures";

async function seedSlackConnection(opts: {
  organizationId: string;
  agentId: string;
  connectionId: string;
	status?: "active" | "stopped" | "error" | "paused";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await insertChatConnectionRow({
    id: opts.connectionId,
    organizationId: opts.organizationId,
    agentId: opts.agentId,
		platform: "slack",
		status: opts.status ?? "active",
    settings: opts.settings ?? {},
    metadata: opts.metadata ?? {},
  });
}

async function seedBinding(opts: {
  organizationId: string;
  agentId: string;
	connectionId: string;
  channelId: string;
  teamId?: string;
}): Promise<void> {
	const configuredBy = await createTestUser();
	await addUserToOrganization(configuredBy.id, opts.organizationId, "owner");
  await createTestBehaviorSubscription({
    organizationId: opts.organizationId,
    agentId: opts.agentId,
    connectionSlug: `agentconn-${opts.connectionId}`,
    platform: "slack",
    channelId: opts.channelId,
    teamId: opts.teamId ?? "T_TEST",
		configuredBy: configuredBy.id,
  });
}

describe("resolveBotDeliveryTargets", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

	it("resolves an active connection to its bound channel", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0LEADS",
    });

    const targets = await resolveBotDeliveryTargets(org.id);

    expect(targets).toEqual([
			{
				connectionId: "conn-1",
				platform: "slack",
				channelKey: "slack:C0LEADS",
				teamId: "T_TEST",
			},
    ]);
  });

	it("returns one target when multiple Behaviors share a physical channel", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		await seedSlackConnection({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-shared",
		});
		for (let i = 0; i < 2; i++) {
			await seedBinding({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: "conn-shared",
				channelId: "slack:C-SHARED",
			});
		}

		expect(await resolveBotDeliveryTargets(org.id)).toEqual([
			{
				connectionId: "conn-shared",
				platform: "slack",
				channelKey: "slack:C-SHARED",
				teamId: "T_TEST",
			},
		]);
	});

	it("returns nothing for a connection with no binding", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    // No binding seeded.

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

	it("omits inactive connections", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			status: "stopped",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0LEADS",
    });

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

	it("prefixes a bare channel id with the platform", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "C0BARE",
    });

    const targets = await resolveBotDeliveryTargets(org.id);
    expect(targets).toEqual([
			{
				connectionId: "conn-1",
				platform: "slack",
				channelKey: "slack:C0BARE",
				teamId: "T_TEST",
			},
    ]);
  });

	it("honors the connectionId filter", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		for (const id of ["conn-1", "conn-2"]) {
			await seedSlackConnection({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: id,
			});
    }
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-2",
			channelId: "slack:C1",
		});

		const targets = await resolveBotDeliveryTargets(org.id, "conn-2");
		expect(targets.map((t) => t.connectionId)).toEqual(["conn-2"]);
  });

  // --- Hosted-preview cross-org delivery (the proactive-notification bug) ---
  // The shared preview bot is ONE connection, in its OWN org, under a placeholder
  // agent, that fans out to agents across many orgs. A `/lobu link <code>` writes
  // the binding under the LINKING org. So the org-scoped (org, agent) JOIN misses
  // it on both columns and proactive notifications (incl. reaction posts) drop.

	it("cross-org: delivers a tenant org binding through the shared previewMode connection", async () => {
    const hostOrg = await createTestOrganization(); // where the hosted preview conn lives
    const tenantOrg = await createTestOrganization(); // the org that /lobu link'd a channel
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

    await seedSlackConnection({
      organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
      settings: { previewMode: true },
      metadata: {}, // legacy tenantless hosted connection: serves all its bindings
    });
    await seedBinding({
      organizationId: tenantOrg.id, // binding lives in the TENANT org, not the conn's org
			agentId: "food-ordering", // and points at a DIFFERENT agent than the conn's
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
    });

    const targets = await resolveBotDeliveryTargets(tenantOrg.id);
    expect(targets).toEqual([
			{
				connectionId: "preview-conn",
				platform: "slack",
				channelKey: "slack:C0LUNCH",
				teamId: "T_TEST",
			},
    ]);
  });

	it("cross-org: does not expose a tenant binding to the preview connection owner", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});
		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C-TENANT",
		});

		expect(await resolveBotDeliveryTargets(hostOrg.id)).toEqual([]);
	});

	it("cross-org guardrail: a NORMAL (non-preview) connection in another org is never used", async () => {
    const otherOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: otherOrg.id, agentId: "crm" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

    await seedSlackConnection({
      organizationId: otherOrg.id,
			agentId: "crm",
			connectionId: "normal-conn",
      settings: {}, // NOT previewMode
    });
    await seedBinding({
      organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "normal-conn",
			channelId: "slack:C0LUNCH",
    });

    // Multi-tenant wall: org-scoping holds for normal bots.
    expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([]);
  });

	it("cross-org: delivers through a previewMode connection when its workspace matches the binding", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
			metadata: { teamId: "T_HOST" },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
			teamId: "T_HOST",
		});

		expect(await resolveBotDeliveryTargets(tenantOrg.id)).toHaveLength(1);
	});

	it("cross-org guardrail: does not deliver a previewMode binding from another workspace", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
			metadata: { teamId: "T_HOST" },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
			teamId: "T_OTHER",
		});

		expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([]);
	});

	it("does not double-deliver when the org owns its own connection on that channel", async () => {
    const hostOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
    const tenantAgent = await createTestAgent({
      organizationId: tenantOrg.id,
			agentId: "food-ordering",
    });

    await seedSlackConnection({
      organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
      settings: { previewMode: true },
    });
    await seedSlackConnection({
      organizationId: tenantOrg.id,
      agentId: tenantAgent.agentId,
			connectionId: "own-conn",
    });
    await seedBinding({
      organizationId: tenantOrg.id,
      agentId: tenantAgent.agentId,
			connectionId: "own-conn",
			channelId: "slack:C0LUNCH",
    });

    // Only the org's own connection — the preview branch is skipped (NOT EXISTS).
    expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([
			{
				connectionId: "own-conn",
				platform: "slack",
				channelKey: "slack:C0LUNCH",
				teamId: "T_TEST",
			},
    ]);
  });
});

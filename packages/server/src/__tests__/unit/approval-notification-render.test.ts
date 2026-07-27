import { describe, expect, test } from "bun:test";
import {
	type ActionApprovalDetails,
	buildActionApprovalCard,
	formatActionApprovalBody,
	formatActionApprovalTitle,
} from "../../notifications/triggers";

/**
 * Golden-pins approval card/body rendering for all four structured shapes
 * (field change, entity create, entity delete, entity merge) plus the generic
 * fallback. The in-app and Slack expectations differ where their markup
 * syntaxes require different escaping.
 */

function cardText(card: ReturnType<typeof buildActionApprovalCard>): string {
	const first = (card as { children: Array<{ content?: string }> }).children[0];
	return first.content ?? "";
}

describe("approval notification rendering", () => {
	test("field change: body + card with escaping, diff lines, why, review link", () => {
		const details: ActionApprovalDetails = {
			kind: "entity_field_change",
			actorLabel: "Watcher <One>",
			entityId: 7,
			entityType: "topic",
			entityName: "App & Crashes",
			entityUrl: "https://app.lobu.ai/acme/topic/app-crashes",
			fields: { severity: "critical", $name: "New <Name>" },
			current: { severity: "high", $name: "Old Name" },
			reason: "Watcher proposes updating severity (currently set by you).",
		};
		const approvalUrl = "https://app.lobu.ai/acme/runs/42";

		expect(formatActionApprovalTitle("entity_field_change", details)).toBe(
			"Review topic fields: Severity, Name",
		);
		expect(formatActionApprovalBody({ approvalUrl, details })).toBe(
			"**Watcher <One>** wants to update [App & Crashes](https://app.lobu.ai/acme/topic/app-crashes):\n" +
				"- Severity: ~high~\n→ critical\n" +
				"- Name: ~Old Name~\n→ New <Name>\n" +
				"\nField is protected: severity (currently set by you).\n" +
				"\n[Review in Lobu](https://app.lobu.ai/acme/runs/42)",
		);
		expect(cardText(buildActionApprovalCard({ runId: 42, approvalUrl, details }))).toBe(
			"*Requested by:* Watcher &lt;One&gt;\n" +
				"*Entity:* <https://app.lobu.ai/acme/topic/app-crashes|App &amp; Crashes>\n" +
				"\n*Severity*\n~high~\n→ critical\n" +
				"\n*Name*\n~Old Name~\n→ New &lt;Name&gt;\n" +
				"\n*Why approval is needed:* Field is protected: severity (currently set by you).",
		);
	});

	test("field change without name/url/reason: id fallback link, why fallback, leading blank in card", () => {
		const details: ActionApprovalDetails = {
			kind: "entity_field_change",
			entityId: 9,
			entityType: "topic",
			fields: { status: { nested: true } },
			reason: null,
		};
		expect(formatActionApprovalBody({ details })).toBe(
			"**A watcher** wants to update Topic (#9):\n" +
				'- Status: ~Not set~\n→ { "nested": true }\n' +
				"\nThis change needs a human approval before it is applied.",
		);
		expect(cardText(buildActionApprovalCard({ details }))).toBe(
			'\n*Status*\n~Not set~\n→ { "nested": true }\n' +
				"\n*Why approval is needed:* This change needs a human approval before it is applied.",
		);
	});

	test("entity create: proposal listing + reason", () => {
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "create",
			actorLabel: "A watcher",
			entityType: "topic",
			entityName: "Slow & Loading",
			proposal: { entity_type: "topic", name: "Slow & Loading", parent_id: 3 },
			reason: 'A watcher proposes creating topic "Slow & Loading".',
		};
		const approvalUrl = "https://app.lobu.ai/acme/runs/44";
		expect(formatActionApprovalTitle("entity_change", details)).toBe(
			"Review creating topic",
		);
		expect(formatActionApprovalBody({ approvalUrl, details })).toBe(
			"**A watcher** wants to create Slow & Loading.\n" +
				"- Entity type: topic\n- Name: Slow & Loading\n- Parent id: 3\n" +
				'\nA watcher proposes creating topic "Slow & Loading".\n' +
				"\n[Review in Lobu](https://app.lobu.ai/acme/runs/44)",
		);
		expect(cardText(buildActionApprovalCard({ runId: 44, approvalUrl, details }))).toBe(
			"*Requested by:* A watcher\n" +
				"*Entity:* Slow &amp; Loading\n" +
				"\n*Proposed action:* Create this entity\n" +
				"*Entity type:* topic\n*Name:* Slow &amp; Loading\n*Parent id:* 3\n" +
				'\n*Why approval is needed:* A watcher proposes creating topic "Slow &amp; Loading".',
		);
	});

	test("entity delete without reason: no why section; card link strips <>|", () => {
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "delete",
			actorLabel: "An agent",
			entityId: 11,
			entityType: "topic",
			entityName: "Old <Topic>",
			entityUrl: "https://app.lobu.ai/acme/topic/old-topic",
			proposal: {
				entity_id: 11,
				entity_type: "topic",
				name: "Old <Topic>",
				force_delete_tree: false,
			},
			current: { id: 11, entity_type: "topic", name: "Old <Topic>" },
			reason: null,
		};
		expect(formatActionApprovalTitle("entity_change", details)).toBe(
			"Review deleting topic",
		);
		expect(
			formatActionApprovalBody({
				approvalUrl: "https://app.lobu.ai/acme/runs/45",
				details,
			}),
		).toBe(
			"**An agent** wants to delete [Old <Topic>](https://app.lobu.ai/acme/topic/old-topic).\n" +
				"- Entity id: 11\n- Entity type: topic\n- Name: Old <Topic>\n- Force delete tree: false\n" +
				"\n[Review in Lobu](https://app.lobu.ai/acme/runs/45)",
		);
		expect(cardText(buildActionApprovalCard({ runId: 45, details }))).toBe(
			"*Requested by:* An agent\n" +
				"*Entity:* <https://app.lobu.ai/acme/topic/old-topic|Old Topic>\n" +
				"\n*Proposed action:* Delete this entity\n" +
				"*Entity id:* 11\n*Entity type:* topic\n*Name:* Old &lt;Topic&gt;\n*Force delete tree:* false",
		);
	});

	test("entity merge: names both entities and renders a merge action", () => {
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "merge",
			actorLabel: "A watcher",
			entityId: 12,
			entityType: "person",
			entityName: "Duplicate Person",
			proposal: {
				entity_id: 12,
				winner_entity_id: 10,
				name: "Duplicate Person",
				winner_name: "Canonical Person",
			},
			reason: "Duplicate entities need approval before merging.",
		};

		expect(formatActionApprovalTitle("entity_change", details)).toBe(
			"Review merging person",
		);
		expect(formatActionApprovalBody({ details })).toContain(
			"**A watcher** wants to merge Duplicate Person (#12).",
		);
		expect(cardText(buildActionApprovalCard({ details }))).toContain(
			"*Proposed action:* Merge these entities",
		);
	});

	test("escaping is per-surface: Markdown neutralises link/emphasis, Slack neutralises mrkdwn", () => {
		// One hostile name, two surfaces. The Markdown body must not let it forge a
		// link or bold run; the Slack card must not let it ping the channel or
		// spoof `<url|label>`. Neither surface may leak the OTHER's escaping.
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "delete",
			actorLabel: "[Review [nested]](https://evil)",
			entityId: 5,
			entityType: "topic",
			entityName: "*Urgent* <!channel> & [click](https://evil)",
			proposal: { name: "*Urgent* <!channel> & [click](https://evil)" },
			reason: "# [Review [nested]](https://evil)",
		};

		const body = formatActionApprovalBody({ details });
		// Markdown: brackets/emphasis defanged, ampersand left as a literal `&`.
		expect(body).toContain(
			"**[Review [nested]\\](https://evil)** wants to delete " +
				"\\*Urgent\\* <!channel> & [click\\](https://evil) (#5).",
		);
		expect(body).not.toContain("&amp;");
		expect(body).toContain(
			"\n\n\\# [Review [nested]\\](https://evil)",
		);

		const card = cardText(buildActionApprovalCard({ details }));
		// Slack: angle brackets/ampersand entity-escaped so `<!channel>` is inert.
		expect(card).toContain(
			"*Requested by:* [Review [nested]](https://evil)",
		);
		expect(card).toContain(
			"*Entity:* *Urgent* &lt;!channel&gt; &amp; [click](https://evil)",
		);
		// The Markdown backslashes must not bleed into the Slack surface.
		expect(card).not.toContain("\\*");
		expect(card).not.toContain("\\[");
	});

	test("bracketed values stay literal; only link-forming brackets are escaped", () => {
		// A JSON array value ("[ 886 ]") is inert Markdown and must render as
		// typed — escaping every bracket leaked visible backslashes into the card.
		const details: ActionApprovalDetails = {
			kind: "entity_change",
			operation: "merge",
			actorLabel: "An agent",
			entityId: 886,
			entityType: "person",
			entityName: "905319918039@s.whatsapp.net",
			entityUrl: "https://app.lobu.ai/buremba/person/member-0faa51dac0",
			proposal: {
				entity_ids: [886],
				// Only this one forms a link and must be defanged.
				note: "see [Review in Lobu](https://evil)",
			},
			reason: null,
		};
		const body = formatActionApprovalBody({ details });
		expect(body).toContain("- Entity ids: [ 886 ]");
		expect(body).toContain("- Note: see [Review in Lobu\\](https://evil)");
	});

	test("generic action: no card, connection fallback body", () => {
		expect(
			buildActionApprovalCard({ runId: 46, approvalUrl: "https://x" }),
		).toBeUndefined();
		expect(
			formatActionApprovalBody({
				connectionName: "GitHub",
				approvalUrl: "https://app.lobu.ai/acme/runs/46",
			}),
		).toBe(
			"A queued action on GitHub is waiting for your review.\n" +
				"\nReview: [Review in Lobu](https://app.lobu.ai/acme/runs/46)",
		);
		expect(formatActionApprovalTitle("do_thing", undefined)).toBe(
			'Action "do_thing" needs approval',
		);
	});
});

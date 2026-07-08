import { describe, expect, test } from "bun:test";
import {
	type ActionApprovalDetails,
	buildActionApprovalCard,
	formatActionApprovalBody,
	formatActionApprovalTitle,
} from "../../notifications/triggers";

/**
 * Golden-pins the approval card/body rendering for all three shapes
 * (field change, entity create, entity delete) plus the generic fallback —
 * captured from the pre-unification renderer, so the shared model+emitters
 * must stay byte-identical to the three historical blocks.
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
			"Requested by: Watcher &lt;One&gt;\n" +
				"Entity: [App &amp; Crashes](https://app.lobu.ai/acme/topic/app-crashes)\n" +
				"\nProposed change:\n" +
				"Severity:\n~high~\n→ critical\n" +
				"Name:\n~Old Name~\n→ New &lt;Name&gt;\n" +
				"\nWhy approval is needed: Field is protected: severity (currently set by you).\n" +
				"\nReview: [Review in Lobu](https://app.lobu.ai/acme/runs/42)",
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
			"Entity: Topic (#9)\n" +
				"\nProposed change:\n" +
				'Status:\n~Not set~\n→ { "nested": true }\n' +
				"\nWhy approval is needed: This change needs a human approval before it is applied.",
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
			"Requested by: A watcher\n" +
				"Entity: Slow &amp; Loading\n" +
				"\nProposed action: Create this entity\n" +
				"\nEntity type: topic\nName: Slow &amp; Loading\nParent id: 3\n" +
				'\nWhy approval is needed: A watcher proposes creating topic "Slow &amp; Loading".\n' +
				"\nReview: [Review in Lobu](https://app.lobu.ai/acme/runs/44)",
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
			"Requested by: An agent\n" +
				"Entity: [Old &lt;Topic&gt;](https://app.lobu.ai/acme/topic/old-topic)\n" +
				"\nProposed action: Delete this entity\n" +
				"\nEntity id: 11\nEntity type: topic\nName: Old &lt;Topic&gt;\nForce delete tree: false\n" +
				"\nReview: [Review in Lobu](https://app.lobu.ai/acme/runs/45)",
		);
		expect(cardText(buildActionApprovalCard({ runId: 45, details }))).toBe(
			"*Requested by:* An agent\n" +
				"*Entity:* <https://app.lobu.ai/acme/topic/old-topic|Old Topic>\n" +
				"\n*Proposed action:* Delete this entity\n" +
				"*Entity id:* 11\n*Entity type:* topic\n*Name:* Old &lt;Topic&gt;\n*Force delete tree:* false",
		);
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

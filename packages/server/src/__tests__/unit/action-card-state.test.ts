import {
	Actions,
	Button,
	Card,
	CardText,
	LinkButton,
	Select,
	SelectOption,
} from "chat";
import { describe, expect, it } from "vitest";
import {
	addActionOrigin,
	actionOriginSubtitle,
	actionResolutionText,
	settleActionCard,
} from "../../notifications/action-card-state";

describe("terminal action cards", () => {
	it("removes every mutating control, preserves navigation, and records actor/time", () => {
		const card = Card({
			title: "Search Jira issues",
			subtitle: "Atlassian Rovo MCP",
			children: [
				CardText("JQL: project = LOBU"),
				Actions([
					Button({ id: "approve", label: "Approve", style: "primary" }),
					Button({ id: "reject", label: "Reject", style: "danger" }),
					Select({
						id: "priority",
						placeholder: "Priority",
						options: [SelectOption({ label: "High", value: "high" })],
					}),
					LinkButton({
						url: "https://app.lobu.ai/runs/7",
						label: "Review in Lobu",
					}),
				]),
			],
		});

		const settled = settleActionCard(card, {
			status: "rejected",
			actorName: "Burak <admin>",
			resolvedAt: "2026-08-20T12:58:04.444Z",
		});

		expect(settled.children).toEqual([
			CardText("JQL: project = LOBU"),
			CardText("*Rejected* by Burak &lt;admin&gt; · 2026-08-20 12:58 UTC"),
			Actions([
				LinkButton({
					url: "https://app.lobu.ai/runs/7",
					label: "View in Lobu",
				}),
			]),
		]);
	});

	it("formats verified provenance", () => {
		expect(
			actionOriginSubtitle({
				kind: "automation",
				label: "Hourly incident triage",
			}),
		).toBe("Automation: Hourly incident triage");
		expect(
			actionOriginSubtitle({
				kind: "conversation",
				label: "Claude Code — Release prep",
			}),
		).toBe("Conversation: Claude Code — Release prep");
		expect(
			addActionOrigin(Card({ subtitle: "Atlassian Rovo MCP", children: [] }), {
				kind: "automation",
				label: "Hourly incident triage",
			}).subtitle,
		).toBe("Atlassian Rovo MCP · Automation: Hourly incident triage");
	});

	it("bounds and escapes user-controlled receipt text", () => {
		expect(
			actionResolutionText({
				status: "approved",
				actorName: "<!channel> <https://evil.example>",
			}),
		).toBe("*Approved* by &lt;!channel&gt; &lt;https://evil.example&gt;");
	});
});

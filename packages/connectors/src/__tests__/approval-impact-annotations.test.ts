import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", () => connectorSdkMock());

type ConnectorDefinition = {
	actions?: Record<
		string,
		{
			requiresApproval?: boolean;
			annotations?: { destructiveHint?: boolean };
		}
	>;
};

let github: ConnectorDefinition;
let googleCalendar: ConnectorDefinition;
let googleGmail: ConnectorDefinition;

beforeAll(async () => {
	const [githubModule, calendarModule, gmailModule] = await Promise.all([
		import("../github"),
		import("../google_calendar"),
		import("../google_gmail"),
	]);
	github = new githubModule.default().definition;
	googleCalendar = new calendarModule.default().definition;
	googleGmail = new gmailModule.default().definition;
});

function expectApprovalImpact(
	definition: ConnectorDefinition,
	expected: Record<string, "normal" | "high">,
) {
	const approvalActions = Object.entries(definition.actions ?? {}).filter(
		([, action]) => action.requiresApproval === true,
	);
	expect(Object.keys(expected).sort()).toEqual(
		approvalActions.map(([key]) => key).sort(),
	);
	for (const [key, action] of approvalActions) {
		expect(action.annotations?.destructiveHint === true, key).toBe(
			expected[key] === "high",
		);
	}
}

describe("built-in connector approval impact annotations", () => {
	test("classifies every shipped approval-gated action explicitly", () => {
		expectApprovalImpact(github, {
			create_issue: "normal",
			add_issue_comment: "normal",
			close_issue: "normal",
			reopen_issue: "normal",
			create_pull_request: "normal",
			merge_pull_request: "high",
		});
		expectApprovalImpact(googleCalendar, {
			create_event: "normal",
			update_event: "normal",
			delete_event: "high",
		});
		expectApprovalImpact(googleGmail, {
			send_email: "normal",
			reply: "normal",
		});
	});
});

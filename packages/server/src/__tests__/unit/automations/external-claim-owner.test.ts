import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../../tools/registry";
import {
	encodeExternalAutomationClaimOwner,
	isExternalAutomationClaimOwner,
} from "../../../tools/admin/manage_automations/claim-next-window";

const ctx = (over: Partial<ToolContext>): ToolContext => over as ToolContext;

describe("external Automation claim owner", () => {
	it("omits the MCP session, which rotates per tool call", () => {
		const owner = encodeExternalAutomationClaimOwner(
			ctx({ userId: "u1", clientId: "c1", mcpSessionId: "session-a" }),
		);
		expect(owner).not.toContain("session-a");
		// Same caller, different transport session -> identical owner, so a claim
		// stays completable by the caller that opened it.
		expect(
			encodeExternalAutomationClaimOwner(
				ctx({ userId: "u1", clientId: "c1", mcpSessionId: "session-b" }),
			),
		).toBe(owner);
	});

	it("refuses a caller with no identity at all", () => {
		expect(() =>
			encodeExternalAutomationClaimOwner(
				ctx({ userId: null, agentId: null, clientId: null }),
				"complete_window",
			),
		).toThrow(/complete_window requires an identified caller/);
	});

	it("reads its own output as an external claim", () => {
		expect(
			isExternalAutomationClaimOwner(
				encodeExternalAutomationClaimOwner(ctx({ userId: "u1" })),
			),
		).toBe(true);
	});

	it("still reads a legacy session-bearing row as external", () => {
		expect(
			isExternalAutomationClaimOwner(
				'external:{"user_id":"u1","agent_id":null,"client_id":"c1","mcp_session_id":"s1"}',
			),
		).toBe(true);
	});

	it("reads a legacy row whose ONLY identity was the session as external", () => {
		// `trigger` routes on this predicate. Returning false here would push a
		// real external claim into the worker lane.
		expect(
			isExternalAutomationClaimOwner(
				'external:{"user_id":null,"agent_id":null,"client_id":null,"mcp_session_id":"s1"}',
			),
		).toBe(true);
	});

	it("rejects worker claims and malformed owners", () => {
		expect(isExternalAutomationClaimOwner("gateway-abc")).toBe(false);
		expect(isExternalAutomationClaimOwner("mac-abc")).toBe(false);
		expect(isExternalAutomationClaimOwner("external:not-json")).toBe(false);
		expect(isExternalAutomationClaimOwner('external:{"user_id":"u1"}')).toBe(false);
		expect(
			isExternalAutomationClaimOwner(
				'external:{"user_id":"u1","agent_id":null,"client_id":null,"surprise":"x"}',
			),
		).toBe(false);
		expect(
			isExternalAutomationClaimOwner(
				'external:{"user_id":null,"agent_id":null,"client_id":null}',
			),
		).toBe(false);
	});
});

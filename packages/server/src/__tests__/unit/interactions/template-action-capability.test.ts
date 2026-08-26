import {
	__resetEncryptionKeyCacheForTests,
} from "@lobu/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	assertTemplateActionCapability,
	issueTemplateActionCapability,
	issueTemplateActionCapabilityWindow,
	MAX_TEMPLATE_ACTION_SOURCE_EVENTS,
} from "../../../interactions/template-action-capability";
import { MCP_APP_CAPABILITY_MAX_LENGTH } from "../../../tools/mcp-app-capability";
import type { ToolContext } from "../../../tools/registry";

const TEST_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let savedEncryptionKey: string | undefined;

const ctx = {
	organizationId: "org-1",
	userId: "user-1",
	memberRole: "member",
	isAuthenticated: true,
	clientId: "client-1",
	mcpSessionId: "session-1",
	mcpConversationId: "conversation-1",
	tokenType: "oauth",
	scopes: ["mcp:read", "mcp:write"],
	scopedToOrg: true,
	allowCrossOrg: false,
} as ToolContext & {
	userId: string;
	clientId: string;
	mcpSessionId: string;
};

beforeEach(() => {
	savedEncryptionKey = process.env.ENCRYPTION_KEY;
	process.env.ENCRYPTION_KEY = TEST_KEY;
	__resetEncryptionKeyCacheForTests();
});

afterEach(() => {
	if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
	else process.env.ENCRYPTION_KEY = savedEncryptionKey;
	__resetEncryptionKeyCacheForTests();
});

describe("MCP App template-action capability", () => {
	it("binds rendered event ids to the exact user, client, and host conversation", () => {
		const token = issueTemplateActionCapability([42, 43, 42], ctx);
		expect(() => assertTemplateActionCapability(token, 42, ctx)).not.toThrow();
		expect(() => assertTemplateActionCapability(token, 44, ctx)).toThrow(
			/valid MCP App event-action capability/i,
		);
		expect(() =>
			assertTemplateActionCapability(token, 42, {
				...ctx,
				userId: "user-2",
			}),
		).toThrow(/valid MCP App event-action capability/i);
		expect(() =>
			assertTemplateActionCapability(token, 42, {
				...ctx,
				mcpConversationId: "conversation-2",
			}),
		).toThrow(/valid MCP App event-action capability/i);
	});

	it("fails closed when a model calls the tool without hidden result metadata", () => {
		expect(() => assertTemplateActionCapability(null, 42, ctx)).toThrow(
			/valid MCP App event-action capability/i,
		);
	});

	it("refuses to mint a capability the verifier would reject", () => {
		expect(() =>
			issueTemplateActionCapability(
				Array.from(
					{ length: MAX_TEMPLATE_ACTION_SOURCE_EVENTS + 1 },
					(_, index) => index + 1,
				),
				ctx,
			),
		).toThrow(/positive integer source event ids/i);
	});

	it("mints a full-window token the MCP `_meta` ceiling still carries", () => {
		// `mcp-handler` drops a `_meta` capability longer than 4096 characters, so
		// a maximum-size token must stay under it with worst-case (safe-integer)
		// event ids or every click 403s.
		const token = issueTemplateActionCapability(
			Array.from(
				{ length: MAX_TEMPLATE_ACTION_SOURCE_EVENTS },
				(_, index) => Number.MAX_SAFE_INTEGER - index,
			),
			ctx,
		);
		expect(token.length).toBeLessThanOrEqual(MCP_APP_CAPABILITY_MAX_LENGTH);
		expect(() =>
			assertTemplateActionCapability(token, Number.MAX_SAFE_INTEGER, ctx),
		).not.toThrow();
	});

	it("shrinks the event window when long host bindings would overflow `_meta`", () => {
		const longCtx = {
			...ctx,
			organizationId: "o".repeat(64),
			userId: "u".repeat(64),
			clientId: "c".repeat(64),
			mcpSessionId: "s".repeat(128),
			mcpConversationId: "x".repeat(512),
		};
		const ids = Array.from(
			{ length: MAX_TEMPLATE_ACTION_SOURCE_EVENTS },
			(_, index) => Number.MAX_SAFE_INTEGER - index,
		);

		expect(() => issueTemplateActionCapability(ids, longCtx)).toThrow(
			/MCP transport limit/i,
		);
		const issued = issueTemplateActionCapabilityWindow(ids, longCtx);
		expect(issued).not.toBeNull();
		expect(issued?.token.length).toBeLessThanOrEqual(
			MCP_APP_CAPABILITY_MAX_LENGTH,
		);
		expect(issued?.sourceEventIds.length).toBeLessThan(ids.length);
		for (const id of issued?.sourceEventIds ?? []) {
			expect(() =>
				assertTemplateActionCapability(issued?.token, id, longCtx),
			).not.toThrow();
		}
		expect(() =>
			assertTemplateActionCapability(
				issued?.token,
				ids[issued?.sourceEventIds.length ?? 0] as number,
				longCtx,
			),
		).toThrow(/valid MCP App event-action capability/i);
	});
});

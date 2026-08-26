import {
	__resetEncryptionKeyCacheForTests,
} from "@lobu/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	assertTemplateActionCapability,
	issueTemplateActionCapability,
} from "../../../interactions/template-action-capability";
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
				Array.from({ length: 201 }, (_, index) => index + 1),
				ctx,
			),
		).toThrow(/1-200 positive integer source event ids/i);
	});
});

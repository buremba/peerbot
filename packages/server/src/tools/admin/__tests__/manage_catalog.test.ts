import { beforeEach, describe, expect, it, vi } from "vitest";

const listOrgInstalled = vi.fn(async () => ({
	connectors: { kind: "connectors", items: [] },
}));
const listAgentInstalled = vi.fn(async () => ({
	skills: { kind: "skills", items: [] },
}));

vi.mock("../../../catalog/installed", () => ({
	listOrgInstalled,
	listAgentInstalled,
}));

vi.mock("../../../catalog/load", () => ({
	listCatalogEntries: vi.fn(),
}));

import { manageCatalog } from "../manage_catalog";

const ctx = {
	organizationId: "org-1",
	userId: "user-1",
	memberRole: "owner" as const,
	isAuthenticated: true,
	clientId: null,
	tokenType: "session" as const,
	scopedToOrg: true,
	allowCrossOrg: false,
	requestUrl: "http://localhost:8787",
	scopes: ["mcp:admin"],
};

describe("manage_catalog list_installed", () => {
	beforeEach(() => {
		listOrgInstalled.mockClear();
		listAgentInstalled.mockClear();
	});

	it("does not default to org connectors when kinds is explicitly agent-scoped", async () => {
		const result = await manageCatalog(
			{ action: "list_installed", kinds: ["skills"] },
			{} as never,
			ctx,
		);
		expect(result).toEqual({
			error: "`agent_id` is required for agent-scoped installed kinds.",
		});
		expect(listOrgInstalled).not.toHaveBeenCalled();
	});

	it("honors explicit org kinds without adding agent defaults", async () => {
		const result = await manageCatalog(
			{
				action: "list_installed",
				agent_id: "agent-1",
				kinds: ["watchers"],
			},
			{} as never,
			ctx,
		);

		expect(listOrgInstalled).toHaveBeenCalledWith("org-1", ["watchers"], ctx);
		expect(listAgentInstalled).not.toHaveBeenCalled();
		expect(result).toEqual({
			action: "list_installed",
			installed: { connectors: { kind: "connectors", items: [] } },
		});
	});
});

import { ListInstalledAction } from "@lobu/core/contracts/tools/manage-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installed from "../../../catalog/installed";
import {
	AGENT_INSTALLED_KINDS,
	ORG_INSTALLED_KINDS,
} from "../../../catalog/types";
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
		vi.spyOn(installed, "listOrgInstalled").mockResolvedValue({
			connectors: { kind: "connectors", items: [] },
		});
		vi.spyOn(installed, "listAgentInstalled").mockResolvedValue({
			skills: { kind: "skills", items: [] },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not default to org connectors when kinds is explicitly agent-scoped", async () => {
		const result = await manageCatalog(
			{ action: "list_installed", kinds: ["skills"] },
			{} as never,
			ctx
		);
		expect(result).toEqual({
			error: "`agent_id` is required for agent-scoped installed kinds.",
		});
		expect(installed.listOrgInstalled).not.toHaveBeenCalled();
	});

	it("honors explicit org kinds without adding agent defaults", async () => {
		const result = await manageCatalog(
			{
				action: "list_installed",
				agent_id: "agent-1",
				kinds: ["behaviors"],
			},
			{} as never,
			ctx
		);

		expect(installed.listOrgInstalled).toHaveBeenCalledWith(
			"org-1",
			["behaviors"],
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				memberRole: "owner",
				isAuthenticated: true,
			}),
			{ includeCatalog: false }
		);
		expect(installed.listAgentInstalled).not.toHaveBeenCalled();
		expect(result).toEqual({
			action: "list_installed",
			installed: { connectors: { kind: "connectors", items: [] } },
		});
	});

	it("advertises only kinds the handler actually accepts", async () => {
		// The contract description is the agent's only guide to legal `kinds`
		// values. Anything named there must survive `handleListInstalled`'s
		// unknown-kind check, or an agent that follows the docs gets an error.
		const prose = [
			ListInstalledAction.properties.action.description,
			ListInstalledAction.properties.kinds.description,
		].join(" ");
		const documented = [
			...prose.matchAll(
				/\b(connectors|behaviors|skills|providers|guardrails|channels)\b/g
			),
		].map((m) => m[1]);
		expect(documented.length).toBeGreaterThan(0);

		const supported = new Set<string>([
			...ORG_INSTALLED_KINDS,
			...AGENT_INSTALLED_KINDS,
		]);
		expect([...new Set(documented)].filter((k) => !supported.has(k))).toEqual(
			[]
		);
	});

	it("forwards include_catalog to installed listers", async () => {
		await manageCatalog(
			{
				action: "list_installed",
				kinds: ["connectors"],
				include_catalog: true,
			},
			{} as never,
			ctx
		);

		expect(installed.listOrgInstalled).toHaveBeenCalledWith(
			"org-1",
			["connectors"],
			expect.any(Object),
			{ includeCatalog: true }
		);
	});
});

/**
 * Shared visibility rules for SDK method discovery (`search_sdk`) and the
 * sandbox manifest (`query_sdk` / `run_sdk`). Keeps catalog, manifest, and
 * runtime policy aligned on what a caller can actually invoke.
 */

import {
	resolveMaxAccessLevel,
	resolveSdkMaxAccessLevel,
	type ToolAccessLevel,
} from "../auth/tool-access";
import type { MethodAccess } from "./method-metadata";

export type SdkDiscoveryMode = "read" | "full";
export type SdkRequiredTier = "read" | "operate" | "administer";

const TOOL_ACCESS_RANK: Record<ToolAccessLevel, number> = {
	read: 0,
	write: 1,
	admin: 2,
};

function requiredToolAccess(methodAccess: MethodAccess): ToolAccessLevel {
	if (methodAccess === "admin") return "admin";
	if (methodAccess === "write" || methodAccess === "external") return "write";
	return "read";
}

/**
 * One method's access as the tier resolvers consume it: either the bare
 * `MethodAccess` marker, or that marker paired with the tier its delegated
 * `manage_*` action really enforces.
 *
 * Reporting and VISIBILITY deliberately diverge for `external`. Visibility
 * stays keyed on the marker (write-visible, so an owner/admin can trigger the
 * progressive mcp:admin challenge by calling the method); only the tier we
 * REPORT follows `enforcedTier`.
 */
export interface SdkMethodAccess {
	access: MethodAccess;
	enforcedTier?: Exclude<MethodAccess, "external">;
}

export type SdkMethodAccessInput =
	| MethodAccess
	| SdkMethodAccess
	| readonly (MethodAccess | SdkMethodAccess)[];

/**
 * The tool-access level a method's tier REPORTING should be based on: the
 * declared `enforcedTier` when the method carries one, else the marker's own
 * mapping.
 */
function reportedToolAccess(entry: MethodAccess | SdkMethodAccess): ToolAccessLevel {
	if (typeof entry === "string") return requiredToolAccess(entry);
	if (entry.enforcedTier) return requiredToolAccess(entry.enforcedTier);
	return requiredToolAccess(entry.access);
}

/**
 * Public discovery tier for one method or a multi-method lifecycle — the tier
 * REPORTED to callers, so an `external` method with an `enforcedTier` reports
 * that stricter tier rather than the write its marker implies.
 */
export function effectiveSdkRequiredTier(
	methodAccess: SdkMethodAccessInput,
): SdkRequiredTier {
	const accesses: readonly (MethodAccess | SdkMethodAccess)[] =
		typeof methodAccess === "string" || !Array.isArray(methodAccess)
			? [methodAccess as MethodAccess | SdkMethodAccess]
			: (methodAccess as readonly (MethodAccess | SdkMethodAccess)[]);
	const required = accesses.reduce<ToolAccessLevel>((highest, access) => {
		const candidate = reportedToolAccess(access);
		return TOOL_ACCESS_RANK[candidate] > TOOL_ACCESS_RANK[highest]
			? candidate
			: highest;
	}, "read");
	return required === "admin"
		? "administer"
		: required === "write"
			? "operate"
			: "read";
}

export function formatSdkRequiredTier(
	methodAccess: SdkMethodAccessInput,
): string {
	const tier = effectiveSdkRequiredTier(methodAccess);
	if (tier === "administer") {
		return "administer (workspace owner/admin + mcp:admin)";
	}
	if (tier === "operate") return "operate (mcp:write)";
	return "read (mcp:read)";
}

export interface SdkAccessGuidance {
	requiredTier: SdkRequiredTier;
	/** Authorized with the caller's current role + scopes. */
	available: boolean;
	/** Visible through run_sdk so the call can trigger progressive OAuth. */
	progressivelyAuthorizable?: boolean;
	instruction?: string;
}

/**
 * Resolve the effective tier for a method/lifecycle and, when unavailable,
 * give the caller a role-aware next step. Scope elevation helps an owner/admin;
 * it can never turn a regular member into a workspace administrator.
 */
export function resolveSdkAccessGuidance(
	methodAccess: SdkMethodAccessInput,
	memberRole: string | null | undefined,
	scopes: readonly string[] | null | undefined,
): SdkAccessGuidance {
	const requiredTier = effectiveSdkRequiredTier(methodAccess);
	const requiredAccess: ToolAccessLevel =
		requiredTier === "administer"
			? "admin"
			: requiredTier === "operate"
				? "write"
				: "read";
	const currentAccess = resolveMaxAccessLevel(memberRole, scopes);
	const available =
		TOOL_ACCESS_RANK[currentAccess] >= TOOL_ACCESS_RANK[requiredAccess];
	if (available) return { requiredTier, available };

	if (requiredTier === "administer") {
		const isWorkspaceAdmin = memberRole === "owner" || memberRole === "admin";
		const progressivelyAuthorizable =
			isWorkspaceAdmin &&
			TOOL_ACCESS_RANK[resolveSdkMaxAccessLevel(memberRole, scopes)] >=
				TOOL_ACCESS_RANK.admin;
		return {
			requiredTier,
			available,
			...(progressivelyAuthorizable ? { progressivelyAuthorizable: true } : {}),
			instruction: progressivelyAuthorizable
				? "This lifecycle requires administer access (workspace owner/admin + mcp:admin). The admin methods are progressively authorizable through run_sdk: invoking one will return the standard mcp:admin OAuth challenge; after approval, retry the call and repeat search_sdk."
				: isWorkspaceAdmin
					? "This lifecycle requires administer access (workspace owner/admin + mcp:admin). Reconnect or reauthorize this MCP connection with write access first, then repeat search_sdk."
					: "This lifecycle requires administer access (workspace owner/admin + mcp:admin). Ask a workspace owner/admin to continue; changing MCP scopes cannot elevate a regular member to administer access.",
		};
	}

	if (requiredTier === "operate") {
		return {
			requiredTier,
			available,
			instruction: memberRole
				? "This action requires operate access (mcp:write). Reconnect or reauthorize this MCP connection with mcp:write, then repeat search_sdk."
				: "This action requires operate access (workspace member + mcp:write). Ask a workspace member to continue.",
		};
	}

	// requiredTier "read": resolveMaxAccessLevel floors at "read", so the
	// `available` early return above always fires before reaching here.
	return { requiredTier, available };
}

/** Whether a method should appear for this caller + discovery mode. */
export function sdkMethodVisible(
	methodAccess: MethodAccess,
	callerMax: ToolAccessLevel,
	mode: SdkDiscoveryMode,
): boolean {
	if (mode === "read") return methodAccess === "read";
	return (
		TOOL_ACCESS_RANK[callerMax] >=
		TOOL_ACCESS_RANK[requiredToolAccess(methodAccess)]
	);
}

/**
 * Shared visibility rules for SDK method discovery (`search_sdk`) and the
 * sandbox manifest (`query_sdk` / `run_sdk`). Keeps catalog, manifest, and
 * runtime policy aligned on what a caller can actually invoke.
 */

import type { ToolAccessLevel } from "../auth/tool-access";
import type { MethodAccess } from "./method-metadata";

export type SdkDiscoveryMode = "read" | "full";

/** Whether a method should appear for this caller + discovery mode. */
export function sdkMethodVisible(
	methodAccess: MethodAccess,
	callerMax: ToolAccessLevel,
	mode: SdkDiscoveryMode,
): boolean {
	if (mode === "read") return methodAccess === "read";
	if (methodAccess === "read") return true;
	if (methodAccess === "admin") return callerMax === "admin";
	// write | external — member write tier or admin/owner
	return callerMax === "write" || callerMax === "admin";
}
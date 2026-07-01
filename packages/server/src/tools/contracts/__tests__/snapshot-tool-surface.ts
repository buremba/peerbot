/**
 * Computes the observable tool-surface snapshots used by the contract-kernel
 * equivalence test.
 *
 * - `snapshotAccessSurface()` — the per-(tool, action) access matrix and both
 *   SDK manifests. Pinned by `fixtures/access-surface.snapshot.json`, which
 *   was generated BEFORE the contract migration: contract-derived policy must
 *   stay byte-identical to the hand-written tables it replaced.
 * - `snapshotToolsList()` — `getAllTools` output for every option combo.
 *   Pinned by `fixtures/tools-list.snapshot.json`; regenerate it when the
 *   visible tool surface changes intentionally (regen command in the test).
 */

import {
	getRequiredAccessLevel,
	isPublicReadable,
} from "../../../auth/tool-access";
import { enumerateSDKManifest } from "../../../sandbox/sdk-manifest";
import { getAllTools } from "../../registry";

const COMBOS = [
	{ publicOnly: false, maxAccessLevel: "admin" },
	{ publicOnly: false, maxAccessLevel: "write" },
	{ publicOnly: false, maxAccessLevel: "read" },
	{ publicOnly: true, maxAccessLevel: "admin" },
	{ publicOnly: true, maxAccessLevel: "read" },
] as const;

function actionsOf(schema: any): string[] | null {
	const action = schema?.properties?.action;
	if (Array.isArray(action?.enum)) return action.enum.map(String);
	if (typeof action?.const === "string") return [action.const];
	// Flat tools (defineFlatActionTool) keep `action` as a TypeBox union of
	// literals, which serializes as anyOf-of-const inside the property.
	if (Array.isArray(action?.anyOf)) {
		const consts = action.anyOf
			.map((v: any) => v?.const)
			.filter((v: unknown): v is string => typeof v === "string");
		return consts.length > 0 ? consts : null;
	}
	return null;
}

export function snapshotAccessSurface() {
	const full = getAllTools({ publicOnly: false, maxAccessLevel: "admin" });
	const accessMatrix: Record<string, Record<string, unknown>> = {};
	for (const tool of full) {
		const readOnly = tool.annotations?.readOnlyHint === true;
		const actions = actionsOf(tool.inputSchema) ?? ["__none__"];
		// Probe an unknown action too: pins the fallback branch of the access
		// policy (tools with explicit per-action tables treat unknown actions
		// as read-tier; tools without fall back to the readOnly hint).
		for (const action of [...actions, "__unknown_probe__"]) {
			const args = action === "__none__" ? {} : { action };
			accessMatrix[tool.name] ??= {};
			accessMatrix[tool.name][action] = {
				level: getRequiredAccessLevel(tool.name, args, readOnly),
				publicReadable: isPublicReadable(tool.name, args),
			};
		}
	}

	return {
		accessMatrix,
		sdkManifestRead: enumerateSDKManifest("read", { allowCrossOrg: true }),
		sdkManifestFull: enumerateSDKManifest("full", { allowCrossOrg: true }),
	};
}

export function snapshotToolsList() {
	return {
		combos: COMBOS.map((options) => ({
			options,
			tools: getAllTools(options).map((tool) => ({
				name: tool.name,
				actions: actionsOf(tool.inputSchema),
				annotations: tool.annotations ?? null,
				schema: tool.inputSchema,
				description: tool.description,
			})),
		})),
	};
}

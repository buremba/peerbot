/**
 * Capability-contract kernel.
 *
 * A capability contract is the single source of truth for one admin
 * capability: its tools, per-action access tiers, public readability, and
 * ClientSDK projection (method names, docs, input glue). Everything else is
 * DERIVED from it:
 *   - `auth/tool-access.ts` policy tables (member-write / owner-admin /
 *     public-read) via {@link deriveActionTierTable} / {@link derivePublicReadTable}
 *   - `sandbox/method-metadata.ts` entries via {@link deriveSdkDocs}
 *   - the runtime ClientSDK namespace via {@link buildContractNamespace}
 *   - the registry tool rows via {@link contractToolEntry}
 *
 * There is deliberately NO visibility axis (no `internal` flag): a tool's
 * reach is decided purely by per-action access tier × caller role × `mcp:*`
 * scope, identically on MCP, REST, SDK, and CLI.
 *
 * ⚠️ Contract modules (`contracts/*.ts`) must stay pure data — zero value
 * imports. They are value-imported by `auth/tool-access.ts` (which sits inside
 * the registry → handlers → action-router import loop) and by
 * `sandbox/method-metadata.ts` (which must stay light for the
 * run-script-runtime CI guard). Handler/schema *bindings* live with the heavy
 * modules that already import them (`tools/admin/index.ts`, `client-sdk.ts`).
 */

export type ActionTier = "read" | "write" | "admin";
export type MethodAccess = "read" | "write" | "external";

export interface SdkMethodDocs {
	summary: string;
	access: MethodAccess;
	throws?: readonly string[];
	/** Single-line copy-pasteable snippet. */
	example?: string;
	/** Multi-line example surfaced by `search_sdk` for hot-path methods. */
	usageExample?: string;
	/** Cost hint: 'cheap' | 'normal' | 'expensive'. Normal if omitted. */
	cost?: "cheap" | "normal" | "expensive";
}

export interface SdkMethodContract {
	/** Method name on the namespace (`client.<ns>.<method>`). */
	method: string;
	/** Tool this method calls (must have a binding where the namespace is built). */
	tool: string;
	/**
	 * `manage_*` action the method routes to. Omitted = the method calls the
	 * tool handler directly with the mapped input (single-action tools, or a
	 * raw `manage` escape hatch that passes `action` through verbatim).
	 */
	action?: string;
	/**
	 * Adapt the method's caller-facing arguments into handler args. Defaults
	 * to "first argument or `{}`". Must be self-contained — contracts are pure
	 * modules and cannot import anything.
	 */
	mapInput?: (...args: any[]) => Record<string, unknown>;
	/**
	 * Documented in METHOD_METADATA / search_sdk but NOT generated on the
	 * namespace. Exists only to keep pre-existing docs-only entries stable
	 * (e.g. `watchers.upgrade`, which never had a runtime method).
	 */
	docsOnly?: boolean;
	docs: SdkMethodDocs;
}

export interface ActionContract {
	tier: ActionTier;
	/** Readable on public workspaces by anonymous/non-member callers. */
	publicRead?: boolean;
}

/** Mirrors registry ToolAnnotations (kept structural — contracts stay pure). */
export interface ToolAnnotationsContract {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	openWorldHint?: boolean;
	idempotentHint?: boolean;
}

export interface ToolContract {
	name: string;
	description: string;
	/** Defaults to `{ destructiveHint: false }` at the registry binding. */
	annotations?: ToolAnnotationsContract;
	/**
	 * Per-action access tiers. `null` = the tool opts out of per-action policy
	 * and keeps the fallback rule (readOnlyHint decides: non-read-only tools
	 * are admin-tier for every action) — e.g. manage_schedules.
	 */
	actions: Record<string, ActionContract> | null;
	/** Tool-level public readability for tools without per-action policy. */
	publicRead?: "all";
}

export interface CapabilityContract {
	key: string;
	/** ClientSDK namespace; omit for capabilities without an SDK projection. */
	sdkNamespace?: string;
	tools: ToolContract[];
	sdkMethods?: SdkMethodContract[];
}

/**
 * Identity constructor with load-time invariant checks, so a malformed
 * contract fails the boot/import instead of drifting silently.
 */
export function defineCapability(
	contract: CapabilityContract,
): CapabilityContract {
	const toolsByName = new Map(contract.tools.map((t) => [t.name, t]));
	if (toolsByName.size !== contract.tools.length) {
		throw new Error(`capability ${contract.key}: duplicate tool names`);
	}
	const seenMethods = new Set<string>();
	for (const m of contract.sdkMethods ?? []) {
		if (!contract.sdkNamespace) {
			throw new Error(
				`capability ${contract.key}: sdkMethods require sdkNamespace`,
			);
		}
		if (seenMethods.has(m.method)) {
			throw new Error(
				`capability ${contract.key}: duplicate sdk method ${m.method}`,
			);
		}
		seenMethods.add(m.method);
		const tool = toolsByName.get(m.tool);
		if (!tool) {
			throw new Error(
				`capability ${contract.key}: sdk method ${m.method} references unknown tool ${m.tool}`,
			);
		}
		if (m.action && tool.actions && !(m.action in tool.actions)) {
			throw new Error(
				`capability ${contract.key}: sdk method ${m.method} references unknown action ${m.action} on ${m.tool}`,
			);
		}
	}
	return contract;
}

/**
 * Per-tool action sets for one access tier — the shape `auth/tool-access.ts`
 * merges into its policy tables. Tools with `actions: null` emit nothing
 * (they keep the readOnlyHint fallback rule).
 */
export function deriveActionTierTable(
	contracts: readonly CapabilityContract[],
	tier: Exclude<ActionTier, "read">,
): Record<string, Set<string>> {
	const table: Record<string, Set<string>> = {};
	for (const contract of contracts) {
		for (const tool of contract.tools) {
			if (!tool.actions) continue;
			const actions = Object.entries(tool.actions)
				.filter(([, spec]) => spec.tier === tier)
				.map(([name]) => name);
			if (actions.length > 0) table[tool.name] = new Set(actions);
		}
	}
	return table;
}

/**
 * Public-readability table rows: `null` = every action of the tool is
 * public-readable (`publicRead: "all"`); otherwise the set of flagged actions.
 * Tools with neither are omitted (not public at all).
 */
export function derivePublicReadTable(
	contracts: readonly CapabilityContract[],
): Record<string, Set<string> | null> {
	const table: Record<string, Set<string> | null> = {};
	for (const contract of contracts) {
		for (const tool of contract.tools) {
			if (tool.publicRead === "all") {
				table[tool.name] = null;
				continue;
			}
			if (!tool.actions) continue;
			const actions = Object.entries(tool.actions)
				.filter(([, spec]) => spec.publicRead === true)
				.map(([name]) => name);
			if (actions.length > 0) table[tool.name] = new Set(actions);
		}
	}
	return table;
}

/** `METHOD_METADATA` slice: `<namespace>.<method>` → docs. */
export function deriveSdkDocs(
	contracts: readonly CapabilityContract[],
): Record<string, SdkMethodDocs> {
	const docs: Record<string, SdkMethodDocs> = {};
	for (const contract of contracts) {
		if (!contract.sdkNamespace) continue;
		for (const m of contract.sdkMethods ?? []) {
			docs[`${contract.sdkNamespace}.${m.method}`] = m.docs;
		}
	}
	return docs;
}

type BoundHandler = (
	args: any,
	env: any,
	ctx: any,
) => Promise<unknown>;

/**
 * Registry row for one contract tool. Schema + handler are BINDINGS passed in
 * by the caller (the registry module already imports them); the contract
 * contributes name/description/annotations.
 */
export function contractToolEntry<S, H extends BoundHandler>(
	contract: CapabilityContract,
	toolName: string,
	schema: S,
	handler: H,
): {
	name: string;
	description: string;
	schema: S;
	annotations: ToolAnnotationsContract;
	handler: H;
} {
	const tool = contract.tools.find((t) => t.name === toolName);
	if (!tool) {
		throw new Error(
			`capability ${contract.key}: no contract for tool ${toolName}`,
		);
	}
	return {
		name: tool.name,
		description: tool.description,
		schema,
		annotations: tool.annotations ?? { destructiveHint: false },
		handler,
	};
}

/**
 * Build the runtime ClientSDK namespace for a capability. `bindings` maps
 * tool name → handler (heavy imports stay with the caller, `client-sdk.ts`).
 *
 * Action methods force the contract's `action` AFTER spreading the mapped
 * input, so a caller-supplied `action` key can never override the
 * discriminator (same guarantee `createActionCaller` gave).
 */
export function buildContractNamespace(
	contract: CapabilityContract,
	bindings: Record<string, BoundHandler>,
	env: unknown,
	ctx: unknown,
): Record<string, (...args: any[]) => Promise<unknown>> {
	const namespace: Record<string, (...args: any[]) => Promise<unknown>> = {};
	for (const m of contract.sdkMethods ?? []) {
		if (m.docsOnly) continue;
		const handler = bindings[m.tool];
		if (!handler) {
			throw new Error(
				`capability ${contract.key}: missing handler binding for ${m.tool}`,
			);
		}
		const mapInput =
			m.mapInput ??
			((input?: unknown) => (input ?? {}) as Record<string, unknown>);
		if (m.action) {
			const actionName = m.action;
			namespace[m.method] = (...args: any[]) => {
				const { action: _ignored, ...rest } = mapInput(...args);
				return handler({ ...rest, action: actionName }, env, ctx);
			};
		} else {
			namespace[m.method] = (...args: any[]) =>
				handler(mapInput(...args), env, ctx);
		}
	}
	return namespace;
}

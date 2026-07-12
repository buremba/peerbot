/**
 * Method and sandbox-helper discovery for `query_sdk` / `run_sdk`. Match order:
 * exact path drill-down → namespace prefix listing → substring on path +
 * summary. Client method visibility matches the sandbox dispatch manifests.
 */

import { type Static, Type } from "@sinclair/typebox";
import { resolveMaxAccessLevel } from "../auth/tool-access";
import type { Env } from "../index";
import {
	METHOD_METADATA,
	RUNTIME_HELPER_METADATA,
	type MethodMetadata,
} from "../sandbox/method-metadata";
import {
	sdkMethodVisible,
	type SdkDiscoveryMode,
} from "../sandbox/sdk-method-access";
import type { ToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";

const SDK_DISCOVERY_METADATA: Record<string, MethodMetadata> = {
	...METHOD_METADATA,
	...RUNTIME_HELPER_METADATA,
};

const NAMESPACES = [
	...new Set(
		Object.keys(SDK_DISCOVERY_METADATA)
			.filter((path) => path.includes("."))
			.map((path) => path.split(".")[0]),
	),
].sort();

export const SdkSearchSchema = Type.Object({
	query: Type.String({
		description:
			`SDK method or runtime-helper discovery query. Use a namespace (e.g. 'watchers'), one or more dotted paths separated by whitespace (e.g. 'watchers.create ctx.sleep'), an optional client. prefix, or free text. Pass mode='read' for query_sdk-safe methods only; omit mode for your full run_sdk tier. Namespaces: ${NAMESPACES.join(", ")}.`,
		minLength: 1,
	}),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("read", {
					description: "Only methods callable via query_sdk (read access).",
				}),
				Type.Literal("full", {
					description:
						"Methods callable via run_sdk at your access tier (default).",
				}),
			],
			{
				description:
					"Filter results to match query_sdk ('read') or run_sdk ('full', default).",
			},
		),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Max matches to return. Default 20, max 100.",
			minimum: 1,
			maximum: 100,
		}),
	),
});

type SdkSearchArgs = Static<typeof SdkSearchSchema>;

export const SdkSearchResultSchema = Type.Object({
	query: Type.String({ description: "The query that was searched." }),
	match_count: Type.Integer({
		description: "Number of matches returned.",
	}),
	results: Type.Array(Type.String(), {
		description: "Rendered method-documentation strings, one per match.",
	}),
	notes: Type.Optional(
		Type.String({
			description: "Free-text hints (e.g. ambiguity, suggestions) when relevant.",
		}),
	),
});

export type SdkSearchResult = Static<typeof SdkSearchResultSchema>;

function catalogForCaller(
	ctx: ToolContext,
	mode: SdkDiscoveryMode,
): Array<[string, MethodMetadata]> {
	const callerMax = resolveMaxAccessLevel(ctx.memberRole, ctx.scopes);
	return Object.entries(SDK_DISCOVERY_METADATA).filter(([, meta]) =>
		sdkMethodVisible(meta.access, callerMax, mode),
	);
}

function hiddenMethodNote(
	path: string,
	meta: MethodMetadata,
	mode: SdkDiscoveryMode,
): string {
	if (mode === "read" && meta.access !== "read") {
		return `${path} exists but requires run_sdk (access: ${meta.access}). Retry with mode='full' or call via run_sdk.`;
	}
	if (meta.access === "admin") {
		return `${path} requires workspace admin/owner + mcp:admin.`;
	}
	return `${path} is not available at your access tier (access: ${meta.access}).`;
}

function renderListLine(path: string, meta: MethodMetadata): string {
	return `${path} — ${meta.summary}`;
}

function renderDrillDown(path: string, meta: MethodMetadata): string {
	const lines: string[] = [];
	lines.push(path);
	lines.push(`  ${meta.summary}`);
	lines.push(
		`  access: ${meta.access}${meta.cost ? ` (cost: ${meta.cost})` : ""}`,
	);
	if (meta.signature) {
		lines.push(`  signature: ${meta.signature}`);
	}
	if (meta.throws && meta.throws.length > 0) {
		lines.push(`  throws: ${meta.throws.join(", ")}`);
	}
	if (meta.example) {
		lines.push(`  example: ${meta.example}`);
	}
	if (meta.usageExample) {
		lines.push("  usage_example:");
		for (const exampleLine of meta.usageExample.split("\n")) {
			lines.push(`    ${exampleLine}`);
		}
	}
	return lines.join("\n");
}

export const sdkSearch = withValidatedArgs("search_sdk", SdkSearchSchema, sdkSearchImpl);

async function sdkSearchImpl(
	args: SdkSearchArgs,
	_env: Env,
	ctx: ToolContext,
): Promise<SdkSearchResult> {
	const limit = Math.min(args.limit ?? 20, 100);
	const query = args.query.trim();
	const lower = query.toLowerCase();
	const mode: SdkDiscoveryMode = args.mode ?? "full";
	const catalog = catalogForCaller(ctx, mode);
	const methodTokens = lower
		.split(/[\s,]+/)
		.map((token) => token.replace(/^[`'"(]+|[`'").;]+$/g, ""))
		.filter((token) => token.includes("."));

	// Agents commonly ask for several exact methods in one discovery call. Treat
	// each dotted token as its own query instead of searching for the entire
	// whitespace-joined sentence as one impossible substring.
	if (methodTokens.length > 1) {
		const matches = new Map<string, MethodMetadata>();
		for (const token of methodTokens) {
			for (const [path, meta] of catalog) {
				if (path.toLowerCase() === token || path.toLowerCase().includes(token)) {
					matches.set(path, meta);
				}
			}
		}
		const entries = [...matches.entries()];
		const notes: string[] = [];
		if (entries.length > limit) {
			notes.push(
				`${entries.length - limit} more matches; raise \`limit\` or refine the query.`,
			);
		}
		for (const token of methodTokens) {
			const meta = SDK_DISCOVERY_METADATA[token];
			if (meta && !matches.has(token)) {
				notes.push(hiddenMethodNote(token, meta, mode));
			}
		}
		if (mode === "read") {
			notes.push(
				"Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods.",
			);
		}
		return {
			query,
			match_count: entries.length,
			results: entries.slice(0, limit).map(([path, meta]) =>
				methodTokens.includes(path.toLowerCase())
					? renderDrillDown(path, meta)
					: renderListLine(path, meta),
			),
			notes: notes.length > 0 ? notes.join(" ") : undefined,
		};
	}

	if (lower in SDK_DISCOVERY_METADATA) {
		const meta = SDK_DISCOVERY_METADATA[lower];
		const callerMax = resolveMaxAccessLevel(ctx.memberRole, ctx.scopes);
		if (!sdkMethodVisible(meta.access, callerMax, mode)) {
			return {
				query,
				match_count: 0,
				results: [],
				notes: hiddenMethodNote(lower, meta, mode),
			};
		}
		return {
			query,
			match_count: 1,
			results: [renderDrillDown(lower, meta)],
		};
	}

	if (lower.indexOf(".") === -1) {
		const prefix = `${lower}.`;
		const ns = catalog.filter(([p]) => p.startsWith(prefix));
		const topLevel = catalog.filter(([p]) => p === lower);
		const combined = [...topLevel, ...ns];
		if (combined.length > 0) {
			return {
				query,
				match_count: combined.length,
				results: combined
					.slice(0, limit)
					.map(([p, m]) => renderListLine(p, m)),
				notes:
					combined.length > limit
						? `${combined.length - limit} more matches; raise \`limit\` or refine the query.`
						: mode === "read"
							? "Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods."
							: undefined,
			};
		}
	}

	const seen = new Set<string>();
	const matches: Array<[string, MethodMetadata]> = [];
	for (const [path, meta] of catalog) {
		if (path.toLowerCase().includes(lower) && !seen.has(path)) {
			seen.add(path);
			matches.push([path, meta]);
		}
	}
	for (const [path, meta] of catalog) {
		if (meta.summary.toLowerCase().includes(lower) && !seen.has(path)) {
			seen.add(path);
			matches.push([path, meta]);
		}
	}

	if (matches.length === 0) {
		const existsButHidden =
			lower in SDK_DISCOVERY_METADATA
				? hiddenMethodNote(lower, SDK_DISCOVERY_METADATA[lower], mode)
				: undefined;
		return {
			query,
			match_count: 0,
			results: [],
			notes:
				existsButHidden ??
				`No matches at your access tier. Try a namespace (${NAMESPACES.join(", ")}), mode='read' for query_sdk, or a verb (create, list, search).`,
		};
	}

	return {
		query,
		match_count: matches.length,
		results: matches
			.slice(0, limit)
			.map(([p, m]) => renderListLine(p, m)),
		notes:
			matches.length > limit
				? `${matches.length - limit} more matches; raise \`limit\` or refine the query.`
				: mode === "read"
					? "Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods."
					: undefined,
	};
}

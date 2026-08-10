import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import { Type } from "@sinclair/typebox";
import { getDb } from "./db/client";
import type { Env } from "./index";
import type { ToolContext } from "./tools/registry";

const logger = createLogger("mcp-app-result-snapshots");

export const MCP_APP_RESULT_MAX_BYTES = 512 * 1024;
export const MCP_APP_RESULT_RETENTION_DAYS = 30;
export const MCP_APP_RESULT_CONVERSATION_CAP = 50;
const TOOL_CALL_ID_MAX_LENGTH = 512;
const VIEW_STATE_MAX_KEYS = 100;
const VIEW_STATE_KEY_MAX_LENGTH = 120;
const VIEW_STATE_STRING_MAX_LENGTH = 500;
const VIEW_STATE_MAX_BYTES = 8 * 1024;

type UnknownRecord = Record<string, unknown>;
export type McpAppViewState = Record<string, boolean | number | string>;

interface SnapshotPayload {
	version: 1;
	toolName: string;
	data: UnknownRecord;
	viewState: McpAppViewState;
}

interface SnapshotIdentity {
	organizationId: string;
	clientId: string;
	userId: string;
	conversationKey: string;
	toolCallKey: string;
}

interface SnapshotRow {
	body: string;
	tool_name: string;
}

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeMcpAppToolCallId(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	const normalized = String(value).trim();
	return normalized && normalized.length <= TOOL_CALL_ID_MAX_LENGTH
		? normalized
		: null;
}

function hashIdentity(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotIdentity(
	ctx: ToolContext,
	toolCallId: unknown,
): SnapshotIdentity | null {
	const normalizedToolCallId = normalizeMcpAppToolCallId(toolCallId);
	const conversationId = ctx.mcpConversationId?.trim();
	if (
		ctx.mcpAppsSupported !== true ||
		ctx.tokenType !== "oauth" ||
		!ctx.clientId ||
		!ctx.userId ||
		!conversationId ||
		conversationId.length > 512 ||
		!normalizedToolCallId
	) {
		return null;
	}
	return {
		organizationId: ctx.organizationId,
		clientId: ctx.clientId,
		userId: ctx.userId,
		conversationKey: hashIdentity(conversationId),
		toolCallKey: hashIdentity(normalizedToolCallId),
	};
}

/** Remove live approval mutations before a historical result is persisted. */
export function displaySafeMcpAppResult(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(displaySafeMcpAppResult);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, inner]) => {
			if (key === "actions" && Array.isArray(inner)) {
				return [
					key,
					inner
						.filter(
							(action) =>
								!isRecord(action) || action.tool !== "resolve_lobu_approval",
						)
						.map(displaySafeMcpAppResult),
				];
			}
			return [key, displaySafeMcpAppResult(inner)];
		}),
	);
}

/** Accept only small primitive interaction state; result data never flows here. */
export function boundedMcpAppViewState(value: unknown): McpAppViewState {
	if (!isRecord(value)) return {};
	const state: McpAppViewState = {};
	for (const [key, inner] of Object.entries(value).slice(
		0,
		VIEW_STATE_MAX_KEYS,
	)) {
		if (!key || key.length > VIEW_STATE_KEY_MAX_LENGTH) continue;
		if (
			typeof inner !== "boolean" &&
			!(typeof inner === "number" && Number.isFinite(inner)) &&
			!(
				typeof inner === "string" &&
				inner.length <= VIEW_STATE_STRING_MAX_LENGTH
			)
		) {
			continue;
		}
		const candidate = { ...state, [key]: inner as boolean | number | string };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > VIEW_STATE_MAX_BYTES)
			break;
		state[key] = inner as boolean | number | string;
	}
	return state;
}

function parseSnapshot(body: string): SnapshotPayload | null {
	try {
		const parsed: unknown = JSON.parse(decrypt(body));
		if (
			!isRecord(parsed) ||
			parsed.version !== 1 ||
			typeof parsed.toolName !== "string" ||
			!isRecord(parsed.data)
		) {
			return null;
		}
		return {
			version: 1,
			toolName: parsed.toolName,
			data: parsed.data,
			viewState: boundedMcpAppViewState(parsed.viewState),
		};
	} catch {
		return null;
	}
}

function serializeSnapshot(payload: SnapshotPayload): {
	body: string;
	plaintextBytes: number;
} | null {
	const plaintext = JSON.stringify(payload);
	const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
	if (plaintextBytes === 0 || plaintextBytes > MCP_APP_RESULT_MAX_BYTES)
		return null;
	return { body: encrypt(plaintext), plaintextBytes };
}

export async function storeMcpAppResultSnapshot(args: {
	ctx: ToolContext;
	toolCallId: unknown;
	toolName: string;
	data: UnknownRecord;
}): Promise<boolean> {
	const identity = snapshotIdentity(args.ctx, args.toolCallId);
	if (!identity || !args.toolName || args.toolName.length > 120) return false;
	const data = displaySafeMcpAppResult(args.data);
	if (!isRecord(data)) return false;
	const serialized = serializeSnapshot({
		version: 1,
		toolName: args.toolName,
		data,
		viewState: {},
	});
	if (!serialized) return false;

	const sql = getDb();
	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO public.mcp_app_result_snapshots (
				organization_id, client_id, user_id, conversation_key,
				tool_call_key, tool_name, body, plaintext_bytes, expires_at
			) VALUES (
				${identity.organizationId}, ${identity.clientId}, ${identity.userId},
				${identity.conversationKey}, ${identity.toolCallKey}, ${args.toolName},
				${serialized.body}, ${serialized.plaintextBytes},
				now() + (${MCP_APP_RESULT_RETENTION_DAYS} * interval '1 day')
			)
			ON CONFLICT (
				organization_id, client_id, user_id, conversation_key, tool_call_key
			) DO UPDATE SET
				tool_name = EXCLUDED.tool_name,
				body = EXCLUDED.body,
				plaintext_bytes = EXCLUDED.plaintext_bytes,
				expires_at = EXCLUDED.expires_at,
				updated_at = now()
		`;
		await tx`
			DELETE FROM public.mcp_app_result_snapshots snapshot
			WHERE snapshot.organization_id = ${identity.organizationId}
				AND snapshot.client_id = ${identity.clientId}
				AND snapshot.user_id = ${identity.userId}
				AND snapshot.conversation_key = ${identity.conversationKey}
				AND snapshot.tool_call_key NOT IN (
					SELECT kept.tool_call_key
					FROM public.mcp_app_result_snapshots kept
					WHERE kept.organization_id = ${identity.organizationId}
						AND kept.client_id = ${identity.clientId}
						AND kept.user_id = ${identity.userId}
						AND kept.conversation_key = ${identity.conversationKey}
					ORDER BY kept.updated_at DESC, kept.tool_call_key
					LIMIT ${MCP_APP_RESULT_CONVERSATION_CAP}
				)
		`;
	});
	return true;
}

export const RestoreMcpAppResultSchema = Type.Object({
	tool_call_id: Type.Union([
		Type.String({ minLength: 1, maxLength: TOOL_CALL_ID_MAX_LENGTH }),
		Type.Number(),
	]),
});

export const RestoreMcpAppResultOutputSchema = Type.Object({
	found: Type.Boolean(),
	tool_name: Type.Optional(Type.String()),
	data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	view_state: Type.Record(
		Type.String(),
		Type.Union([Type.Boolean(), Type.Number(), Type.String()]),
	),
});

export async function restoreMcpAppResult(
	args: { tool_call_id: string | number },
	_env: Env,
	ctx: ToolContext,
) {
	const identity = snapshotIdentity(ctx, args.tool_call_id);
	if (!identity) return { found: false, view_state: {} };
	const sql = getDb();
	const [row] = await sql<SnapshotRow>`
		SELECT body, tool_name
		FROM public.mcp_app_result_snapshots
		WHERE organization_id = ${identity.organizationId}
			AND client_id = ${identity.clientId}
			AND user_id = ${identity.userId}
			AND conversation_key = ${identity.conversationKey}
			AND tool_call_key = ${identity.toolCallKey}
			AND expires_at > now()
	`;
	if (!row) return { found: false, view_state: {} };
	const snapshot = parseSnapshot(row.body);
	if (!snapshot) {
		logger.warn(
			{ toolName: row.tool_name },
			"Discarded unreadable MCP App result snapshot",
		);
		return { found: false, view_state: {} };
	}
	return {
		found: true,
		tool_name: snapshot.toolName,
		data: snapshot.data,
		view_state: snapshot.viewState,
	};
}

export const SaveMcpAppStateSchema = Type.Object({
	tool_call_id: Type.Union([
		Type.String({ minLength: 1, maxLength: TOOL_CALL_ID_MAX_LENGTH }),
		Type.Number(),
	]),
	view_state: Type.Record(Type.String(), Type.Unknown()),
});

export const SaveMcpAppStateOutputSchema = Type.Object({ saved: Type.Boolean() });

export async function saveMcpAppState(
	args: { tool_call_id: string | number; view_state: UnknownRecord },
	_env: Env,
	ctx: ToolContext,
) {
	const identity = snapshotIdentity(ctx, args.tool_call_id);
	if (!identity) return { saved: false };
	const viewState = boundedMcpAppViewState(args.view_state);
	const sql = getDb();
	return sql.begin(async (tx) => {
		const [row] = await tx<SnapshotRow>`
			SELECT body, tool_name
			FROM public.mcp_app_result_snapshots
			WHERE organization_id = ${identity.organizationId}
				AND client_id = ${identity.clientId}
				AND user_id = ${identity.userId}
				AND conversation_key = ${identity.conversationKey}
				AND tool_call_key = ${identity.toolCallKey}
				AND expires_at > now()
			FOR UPDATE
		`;
		if (!row) return { saved: false };
		const snapshot = parseSnapshot(row.body);
		if (!snapshot) return { saved: false };
		const serialized = serializeSnapshot({ ...snapshot, viewState });
		if (!serialized) return { saved: false };
		await tx`
			UPDATE public.mcp_app_result_snapshots
			SET body = ${serialized.body},
				plaintext_bytes = ${serialized.plaintextBytes},
				expires_at = now() + (${MCP_APP_RESULT_RETENTION_DAYS} * interval '1 day'),
				updated_at = now()
			WHERE organization_id = ${identity.organizationId}
				AND client_id = ${identity.clientId}
				AND user_id = ${identity.userId}
				AND conversation_key = ${identity.conversationKey}
				AND tool_call_key = ${identity.toolCallKey}
		`;
		return { saved: true };
	});
}

export async function cleanupExpiredMcpAppResultSnapshots(): Promise<number> {
	const rows = await getDb()`
		DELETE FROM public.mcp_app_result_snapshots WHERE expires_at <= now()
	`;
	return rows.count;
}

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import { Type } from "@sinclair/typebox";
import { getDb } from "./db/client";
import type { Env } from "./index";
import type { ToolContext } from "./tools/registry";
import { withValidatedArgs } from "./tools/validate-args";

const logger = createLogger("mcp-app-result-snapshots");

const MCP_APP_RESULT_MAX_BYTES = 512 * 1024;
const MCP_APP_RESULT_RETENTION_DAYS = 30;
const MCP_APP_RESULT_CONVERSATION_CAP = 50;
const TOOL_CALL_ID_MAX_LENGTH = 512;
const TOOL_NAME_MAX_LENGTH = 120;
const VIEW_STATE_MAX_KEYS = 100;
const VIEW_STATE_KEY_MAX_LENGTH = 120;
const VIEW_STATE_STRING_MAX_LENGTH = 500;
const VIEW_STATE_MAX_BYTES = 8 * 1024;

type UnknownRecord = Record<string, unknown>;
type McpAppViewState = Record<string, boolean | number | string>;

interface SnapshotPayload {
	version: 1;
	toolName: string;
	data: UnknownRecord;
	viewState: McpAppViewState;
	/** SHA-256 of the single-use capability; retained after binding for idempotency. */
	bindingKey?: string;
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
			...(typeof parsed.bindingKey === "string" &&
				/^[a-f0-9]{64}$/.test(parsed.bindingKey)
				? { bindingKey: parsed.bindingKey }
				: {}),
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
	bindingCapability?: unknown;
	toolName: string;
	data: UnknownRecord;
}): Promise<boolean> {
	const identity = snapshotIdentity(args.ctx, args.toolCallId);
	if (
		!identity ||
		!args.toolName ||
		args.toolName.length > TOOL_NAME_MAX_LENGTH
	)
		return false;
	const bindingCapability = normalizeMcpAppToolCallId(args.bindingCapability);
	const data = displaySafeMcpAppResult(args.data);
	if (!isRecord(data)) return false;
	const serialized = serializeSnapshot({
		version: 1,
		toolName: args.toolName,
		data,
		viewState: {},
		...(bindingCapability
			? { bindingKey: hashIdentity(bindingCapability) }
			: {}),
	});
	if (!serialized) return false;

	const sql = getDb();
	const collided = await sql.begin(async (tx) => {
		const [stored] = await tx<{ collided: boolean }>`
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
				-- A host request ID is not guaranteed to be unique forever. Never let a
				-- collision replace the historical card with a different result.
				expires_at = now(),
				updated_at = now()
			RETURNING expires_at <= now() AS collided
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
		return stored?.collided === true;
	});
	if (collided) {
		logger.warn(
			{ toolName: args.toolName },
			"MCP App result snapshot key collision; historical restore disabled",
		);
	}
	return !collided;
}

export const RestoreMcpAppResultSchema = Type.Object({
	tool_call_id: Type.Union([
		Type.String({ minLength: 1, maxLength: TOOL_CALL_ID_MAX_LENGTH }),
		Type.Number(),
	]),
	tool_name: Type.Optional(
		Type.String({ minLength: 1, maxLength: TOOL_NAME_MAX_LENGTH }),
	),
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

async function restoreMcpAppResultImpl(
	args: { tool_call_id: string | number; tool_name?: string },
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
	if (args.tool_name && row.tool_name !== args.tool_name)
		return { found: false, view_state: {} };
	const snapshot = parseSnapshot(row.body);
	if (!snapshot || snapshot.toolName !== row.tool_name) {
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

export const restoreMcpAppResult = withValidatedArgs(
	"restore_lobu_app_result",
	RestoreMcpAppResultSchema,
	restoreMcpAppResultImpl,
);

export const SaveMcpAppStateSchema = Type.Object({
	tool_call_id: Type.Union([
		Type.String({ minLength: 1, maxLength: TOOL_CALL_ID_MAX_LENGTH }),
		Type.Number(),
	]),
	tool_name: Type.Optional(
		Type.String({ minLength: 1, maxLength: TOOL_NAME_MAX_LENGTH }),
	),
	view_state: Type.Record(Type.String(), Type.Unknown()),
});

export const SaveMcpAppStateOutputSchema = Type.Object({ saved: Type.Boolean() });

async function saveMcpAppStateImpl(
	args: {
		tool_call_id: string | number;
		tool_name?: string;
		view_state: UnknownRecord;
	},
	_env: Env,
	ctx: ToolContext,
) {
	const identity = snapshotIdentity(ctx, args.tool_call_id);
	if (!identity) return { saved: false };
	const viewState = boundedMcpAppViewState(args.view_state);
	const sql = getDb();
	const bindingIdentity = snapshotIdentity(
		ctx,
		ctx.mcpAppSnapshotCapability,
	);
	if (
		bindingIdentity &&
		bindingIdentity.toolCallKey !== identity.toolCallKey
	) {
		try {
			return await sql.begin(async (tx) => {
				const [candidate] = await tx<SnapshotRow>`
					SELECT body, tool_name
					FROM public.mcp_app_result_snapshots
					WHERE organization_id = ${bindingIdentity.organizationId}
						AND client_id = ${bindingIdentity.clientId}
						AND user_id = ${bindingIdentity.userId}
						AND conversation_key = ${bindingIdentity.conversationKey}
						AND tool_call_key = ${bindingIdentity.toolCallKey}
						AND expires_at > now()
					FOR UPDATE
				`;
				const row =
					candidate ??
					(
						await tx<SnapshotRow>`
							SELECT body, tool_name
							FROM public.mcp_app_result_snapshots
							WHERE organization_id = ${identity.organizationId}
								AND client_id = ${identity.clientId}
								AND user_id = ${identity.userId}
								AND conversation_key = ${identity.conversationKey}
								AND tool_call_key = ${identity.toolCallKey}
								AND expires_at > now()
						`
					)[0];
				if (!row) return { saved: false };
				if (args.tool_name && row.tool_name !== args.tool_name)
					return { saved: false };
				const snapshot = parseSnapshot(row.body);
				if (
					!snapshot ||
					snapshot.toolName !== row.tool_name ||
					snapshot.bindingKey !== bindingIdentity.toolCallKey
				)
					return { saved: false };
				const serialized = serializeSnapshot({ ...snapshot, viewState });
				if (!serialized) return { saved: false };
				const sourceIdentity = candidate ? bindingIdentity : identity;
				const updated = await tx`
					UPDATE public.mcp_app_result_snapshots
					SET tool_call_key = ${identity.toolCallKey},
						body = ${serialized.body},
						plaintext_bytes = ${serialized.plaintextBytes},
						updated_at = now()
					WHERE organization_id = ${sourceIdentity.organizationId}
						AND client_id = ${sourceIdentity.clientId}
						AND user_id = ${sourceIdentity.userId}
						AND conversation_key = ${sourceIdentity.conversationKey}
						AND tool_call_key = ${sourceIdentity.toolCallKey}
				`;
				return { saved: updated.count === 1 };
			});
		} catch (error) {
			if (!isRecord(error) || error.code !== "23505") throw error;
			await sql`
				UPDATE public.mcp_app_result_snapshots
				SET expires_at = now(), updated_at = now()
				WHERE organization_id = ${bindingIdentity.organizationId}
					AND client_id = ${bindingIdentity.clientId}
					AND user_id = ${bindingIdentity.userId}
					AND conversation_key = ${bindingIdentity.conversationKey}
					AND tool_call_key = ${bindingIdentity.toolCallKey}
			`;
			logger.warn(
				{ toolName: args.tool_name },
				"MCP App host card key collision; candidate restore disabled",
			);
			return { saved: false };
		}
	}
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
		if (args.tool_name && row.tool_name !== args.tool_name)
			return { saved: false };
		const snapshot = parseSnapshot(row.body);
		if (!snapshot || snapshot.toolName !== row.tool_name)
			return { saved: false };
		const serialized = serializeSnapshot({ ...snapshot, viewState });
		if (!serialized) return { saved: false };
		await tx`
			UPDATE public.mcp_app_result_snapshots
			SET body = ${serialized.body},
				plaintext_bytes = ${serialized.plaintextBytes},
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

export const saveMcpAppState = withValidatedArgs(
	"save_lobu_app_state",
	SaveMcpAppStateSchema,
	saveMcpAppStateImpl,
);

export async function cleanupExpiredMcpAppResultSnapshots(): Promise<number> {
	const rows = await getDb()`
		DELETE FROM public.mcp_app_result_snapshots WHERE expires_at <= now()
	`;
	return rows.count;
}

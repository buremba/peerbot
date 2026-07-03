import { getDb } from "../../db/client.js";
import { getChatInstanceManager } from "../../lobu/gateway.js";
import {
	runtimeConnectionIdToSlug,
	slugToRuntimeConnectionId,
} from "../../lobu/stores/connections-projection.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { PlatformAdapterConfigSchema } from "../routes/schemas/platform-config.js";
import { isAdapterlessPlatform } from "./chat-instance-manager.js";
import { getPlatformDescriptor } from "./platforms/index.js";
import { createSlackWebApi } from "./slack-web.js";
import type { PlatformAdapterConfig } from "./types.js";

const CHAT_LOCK_NAMESPACE = 0x63686174; // "chat"

type ReservedSql = ((
	strings: TemplateStringsArray,
	...values: unknown[]
) => Promise<unknown[]>) & { release(): void };

export interface ChatConnectionRow {
	id: number;
	organization_id: string;
	connector_key: string;
	slug: string;
	credential_mode: "byo" | "managed";
	status: string;
	config: Record<string, unknown>;
	display_name: string | null;
}

export interface UpsertChatConnectionInput {
	organizationId: string;
	platform: string;
	stableId: string;
	displayName?: string;
	agentId?: string;
	config: Record<string, unknown>;
	settings?: { allowFrom?: string[]; allowGroups?: boolean };
}

function hashLockKey(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

async function withStableChatLock<T>(
	organizationId: string,
	stableId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const sql = getDb() as unknown as { reserve(): Promise<ReservedSql> };
	const reserved = await sql.reserve();
	const key = hashLockKey(`${organizationId}:${stableId}`);
	try {
		await reserved`SELECT pg_advisory_lock(${CHAT_LOCK_NAMESPACE}, ${key})`;
		try {
			return await fn();
		} finally {
			await reserved`SELECT pg_advisory_unlock(${CHAT_LOCK_NAMESPACE}, ${key})`;
		}
	} finally {
		reserved.release();
	}
}

function requireManager() {
	const manager = getChatInstanceManager();
	if (!manager) {
		throw new Error(
			"Chat connection manager unavailable — retry once startup completes",
		);
	}
	return manager;
}

function requireChatPlatform(platform: string): void {
	// Adapterless platforms (rest, webhook) have no descriptor by design — the
	// row persists but no chat instance is ever created (lobu-ai/lobu#1179).
	if (!getPlatformDescriptor(platform) && !isAdapterlessPlatform(platform)) {
		throw new Error(`Unsupported chat platform: ${platform}`);
	}
}

function validateRequiredCredentials(
	platform: string,
	config: Record<string, unknown>,
): void {
	const requiredByPlatform: Record<string, string[]> = {
		slack: ["botToken", "signingSecret"],
		telegram: ["botToken"],
		discord: ["botToken", "applicationId", "publicKey"],
		whatsapp: ["accessToken", "phoneNumberId", "appSecret", "verifyToken"],
		teams: ["appId", "appPassword"],
		gchat: ["credentials", "googleChatProjectNumber"],
	};
	const missing = (requiredByPlatform[platform] ?? []).filter((key) => {
		const value = config[key];
		return typeof value !== "string" || value.trim().length === 0;
	});
	if (missing.length > 0) {
		throw new Error(
			`Missing required ${platform} configuration: ${missing.join(", ")}`,
		);
	}
}

function parseConfig(
	platform: string,
	rawConfig: Record<string, unknown>,
): PlatformAdapterConfig {
	requireChatPlatform(platform);
	const parsed = PlatformAdapterConfigSchema.safeParse({
		...rawConfig,
		platform,
	});
	if (!parsed.success) {
		throw new Error(
			parsed.error.issues.map((issue) => issue.message).join("; "),
		);
	}
	validateRequiredCredentials(platform, parsed.data);
	return parsed.data;
}

async function validateProviderIdentity(
	platform: string,
	config: PlatformAdapterConfig,
): Promise<Record<string, unknown>> {
	const metadata: Record<string, unknown> = {};
	if (platform === "slack") {
		const botToken = config.botToken;
		if (!botToken) throw new Error("Slack bot token is required");
		const identity = await createSlackWebApi().authTest(botToken);
		metadata.teamId = identity.teamId;
	}
	return metadata;
}

export async function getChatConnectionRow(
	organizationId: string,
	connectionId: number,
): Promise<ChatConnectionRow | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, connector_key, slug, credential_mode, status,
           config, display_name
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as ChatConnectionRow[];
	return rows[0] ?? null;
}

export async function upsertByoChatConnection(
	input: UpsertChatConnectionInput,
): Promise<{
	connectionId: number;
	runtimeId: string;
	created: boolean;
	changed: boolean;
}> {
	return withStableChatLock(input.organizationId, input.stableId, async () => {
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(input.stableId);
		const existingRows = (await sql`
      SELECT id, slug, connector_key, config, status, display_name, agent_id
      FROM connections
      WHERE organization_id = ${input.organizationId}
        AND slug = ${slug}
        AND credential_mode = 'byo'
        AND deleted_at IS NULL
      LIMIT 1
    `) as Array<{
			id: number;
			slug: string;
			connector_key: string;
			config: Record<string, unknown>;
			status: string;
			display_name: string | null;
			agent_id: string | null;
		}>;

		const config = parseConfig(input.platform, input.config);
		const manager = requireManager();
		const settings = { allowGroups: true, ...(input.settings ?? {}) };
		const existing = existingRows[0];
		if (!existing) {
			const providerMetadata = await validateProviderIdentity(
				input.platform,
				config,
			);
			await orgContext.run({ organizationId: input.organizationId }, () =>
				manager.addConnection(
					input.platform,
					input.agentId,
					config,
					settings,
					{
						...providerMetadata,
						...(input.displayName ? { teamName: input.displayName } : {}),
					},
					input.stableId,
				),
			);
			const rows = (await sql`
        SELECT id FROM connections
        WHERE organization_id = ${input.organizationId}
          AND slug = ${slug}
          AND deleted_at IS NULL
        LIMIT 1
      `) as Array<{ id: number }>;
			if (!rows[0]) throw new Error("Chat connection did not persist");
			return {
				connectionId: rows[0].id,
				runtimeId: input.stableId,
				created: true,
				changed: true,
			};
		}
		if (existing.connector_key !== input.platform) {
			throw new Error(
				`Chat connection ${input.stableId} is already ${existing.connector_key}; stable IDs cannot change platform`,
			);
		}
		// A stable ID names ONE agent's connection: a colliding apply from another
		// agent must not silently reparent the row and steal its traffic.
		if (
			input.agentId !== undefined &&
			existing.agent_id !== null &&
			existing.agent_id !== input.agentId
		) {
			throw new Error(
				`Stable ID ${input.stableId} is already used by a different agent`,
			);
		}
		// An apply that omits agent_id keeps the current owner rather than
		// orphaning the connection.
		const agentId = input.agentId ?? existing.agent_id ?? undefined;

		const matches = await orgContext.run(
			{ organizationId: input.organizationId },
			() =>
				manager.connectionMatches(input.stableId, config, settings, agentId),
		);
		if (
			matches &&
			(!input.displayName || existing.display_name === input.displayName)
		) {
			return {
				connectionId: existing.id,
				runtimeId: input.stableId,
				created: false,
				changed: false,
			};
		}

		const providerMetadata = matches
			? {}
			: await validateProviderIdentity(input.platform, config);
		await orgContext.run({ organizationId: input.organizationId }, () =>
			manager.updateConnection(input.stableId, {
				agentId: agentId ?? null,
				...(matches ? {} : { config }),
				settings,
				metadata: {
					...providerMetadata,
					...(input.displayName ? { teamName: input.displayName } : {}),
				},
			}),
		);
		if (input.displayName && existing.display_name !== input.displayName) {
			await sql`
        UPDATE connections
        SET display_name = ${input.displayName}, updated_at = now()
        WHERE id = ${existing.id} AND organization_id = ${input.organizationId}
      `;
		}
		return {
			connectionId: existing.id,
			runtimeId: input.stableId,
			created: false,
			changed: true,
		};
	});
}

export async function updateChatConnection(input: {
	organizationId: string;
	connectionId: number;
	displayName?: string;
	config?: Record<string, unknown>;
	status?: string;
}): Promise<void> {
	const row = await getChatConnectionRow(
		input.organizationId,
		input.connectionId,
	);
	if (!row) throw new Error("Chat connection not found");
	// Managed installs own their credentials, but credential-free updates —
	// pause/resume, rename — still apply to them.
	if (row.credential_mode !== "byo" && input.config) {
		throw new Error("Managed app credentials cannot be edited directly");
	}
	const runtimeId = slugToRuntimeConnectionId(row.slug);
	const manager = requireManager();
	if (input.config) {
		const currentConfig = { ...(row.config ?? {}) };
		delete currentConfig.settings;
		delete currentConfig.chatMetadata;
		const merged = {
			...currentConfig,
			...input.config,
		} as PlatformAdapterConfig;
		const resolved = await manager.resolveConnectionConfig(runtimeId, merged);
		const config = parseConfig(row.connector_key, resolved);
		const providerMetadata = await validateProviderIdentity(
			row.connector_key,
			config,
		);
		await orgContext.run({ organizationId: input.organizationId }, () =>
			manager.updateConnection(runtimeId, {
				config,
				metadata: {
					...providerMetadata,
					...(input.displayName ? { teamName: input.displayName } : {}),
				},
			}),
		);
	}
	if (input.status === "active") {
		await manager.restartConnection(runtimeId);
	} else if (input.status === "paused") {
		await manager.stopConnection(runtimeId);
	}
	if (input.displayName !== undefined) {
		const sql = getDb();
		await sql`
      UPDATE connections
      SET display_name = ${input.displayName || row.connector_key}, updated_at = now()
      WHERE id = ${row.id} AND organization_id = ${input.organizationId}
    `;
	}
}

export async function deleteChatConnection(
	organizationId: string,
	connectionId: number,
): Promise<void> {
	const row = await getChatConnectionRow(organizationId, connectionId);
	if (!row) throw new Error("Chat connection not found");
	const manager = requireManager();
	if (row.credential_mode === "managed") {
		await manager.revokeManagedConnection(connectionId);
		return;
	}
	await orgContext.run({ organizationId }, () =>
		manager.removeConnection(slugToRuntimeConnectionId(row.slug)),
	);
}

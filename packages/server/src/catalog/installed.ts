import type { GuardrailStage } from "@lobu/core";
import { getModelProviderModules } from "../gateway/modules/module-system";
import type { Env } from "../index";
import { getLobuCoreServices } from "../lobu/gateway";
import {
	createPostgresAgentConfigStore,
	createPostgresAgentConnectionStore,
} from "../lobu/stores/postgres-stores";
import {
	EMPTY_SUMMARY,
	getOperationsSummaryBatch,
} from "../operations/catalog";
import { listScopedConnectorDefinitions } from "../tools/admin/connector-definition-helpers";
import { handleList } from "../tools/admin/manage_watchers/list";
import type { ToolContext } from "../tools/registry";
import { connectorSourcePathToUri } from "../utils/connector-definition-install";
import type {
	AgentInstalledKind,
	InstalledItem,
	InstalledListResponse,
	OrgInstalledKind,
} from "./types";

const configStore = createPostgresAgentConfigStore();
const connectionStore = createPostgresAgentConnectionStore();

export async function listOrgInstalled(
	organizationId: string,
	kinds: OrgInstalledKind[],
	ctx: Pick<
		ToolContext,
		"organizationId" | "userId" | "memberRole" | "isAuthenticated"
	>,
): Promise<InstalledListResponse["installed"]> {
	const result: InstalledListResponse["installed"] = {};
	const wanted = new Set(kinds);

	if (wanted.has("connectors")) {
		const rows = await listScopedConnectorDefinitions({ organizationId });
		const summaries = await getOperationsSummaryBatch(
			organizationId,
			rows.map((row) => row.key),
		);
		result.connectors = {
			kind: "connectors",
			items: rows.map((row) => {
				const operationsSummary = summaries.get(row.key) ?? {
					...EMPTY_SUMMARY,
				};
				return {
					id: row.key,
					name: row.name,
					detail: {
						version: row.version,
						description: row.description,
						status: row.status,
						login_enabled: Boolean(row.login_enabled),
						auth_schema: row.auth_schema,
						feeds_schema: row.feeds_schema,
						actions_schema: row.actions_schema,
						options_schema: row.options_schema,
						favicon_domain: row.favicon_domain,
						required_capability: row.required_capability,
						runtime: row.runtime,
						default_connection_config: row.default_connection_config,
						default_repair_agent_id: row.default_repair_agent_id,
						source_uri: connectorSourcePathToUri(row.source_path),
						operations_summary: operationsSummary,
						has_operations: operationsSummary.total > 0,
					},
				};
			}),
		};
	}

	if (wanted.has("watchers")) {
		const toolCtx: ToolContext = {
			organizationId,
			userId: ctx.userId ?? null,
			memberRole: ctx.memberRole ?? null,
			isAuthenticated: ctx.isAuthenticated ?? false,
			clientId: null,
			tokenType: "session",
			scopedToOrg: true,
			allowCrossOrg: false,
			requestUrl: "",
		};
		const listed = await handleList({ status: "active" }, {} as Env, toolCtx);
		const watchers = Array.isArray(listed.watchers) ? listed.watchers : [];
		result.watchers = {
			kind: "watchers",
			items: watchers.map((watcher: Record<string, unknown>) => ({
				id: String(watcher.watcher_id ?? watcher.id ?? ""),
				name: String(watcher.name ?? watcher.watcher_name ?? "Watcher"),
				detail: {
					slug: watcher.slug,
					status: watcher.status,
					agent_id: watcher.agent_id,
					entity_id: watcher.entity_id,
					schedule: watcher.schedule,
					version: watcher.version,
				},
			})),
		};
	}

	return result;
}

export async function listAgentInstalled(
	agentId: string,
	kinds: AgentInstalledKind[],
): Promise<InstalledListResponse["installed"]> {
	const result: InstalledListResponse["installed"] = {};
	const wanted = new Set(kinds);

	const settings = await configStore.getSettings(agentId);
	if (!settings) return result;

	if (wanted.has("skills")) {
		const skills = settings.skillsConfig?.skills ?? [];
		result.skills = {
			kind: "skills",
			items: skills.map((skill) => ({
				id: skill.repo,
				name: skill.name,
				detail: {
					enabled: skill.enabled,
					description: skill.description,
					system: skill.system,
					mcp_servers: skill.mcpServers,
					nix_packages: skill.nixPackages,
					network_config: skill.networkConfig,
				},
			})),
		};
	}

	if (wanted.has("providers")) {
		const installed = settings.installedProviders ?? [];
		const installedById = new Map(
			installed.map((provider) => [provider.providerId, provider]),
		);
		const modules = getModelProviderModules().filter(
			(module) => module.catalogVisible !== false,
		);
		result.providers = {
			kind: "providers",
			items: modules.map((module) => {
				const entry = installedById.get(module.providerId);
				return {
					id: module.providerId,
					name: module.providerDisplayName,
					detail: {
						icon_url: module.providerIconUrl ?? "",
						auth_type: module.authType ?? "api-key",
						supported_auth_types: module.supportedAuthTypes ?? [
							module.authType ?? "api-key",
						],
						api_key_instructions: module.apiKeyInstructions ?? "",
						api_key_placeholder: module.apiKeyPlaceholder ?? "",
						description: module.catalogDescription ?? "",
						system_available: module.hasSystemKey(),
						installed: Boolean(entry),
						installed_at: entry?.installedAt,
					},
				};
			}),
		};
	}

	if (wanted.has("guardrails")) {
		const enabled = new Set(settings.guardrails ?? []);
		const core = getLobuCoreServices();
		const registry = core?.getGuardrailRegistry?.();
		const items: InstalledItem[] = [];
		if (registry) {
			const stages: GuardrailStage[] = ["input", "output", "pre-tool"];
			for (const stage of stages) {
				for (const guardrail of registry.list(stage)) {
					items.push({
						id: guardrail.name,
						name: guardrail.name,
						detail: {
							stage: guardrail.stage,
							enabled: enabled.has(guardrail.name),
						},
					});
				}
			}
		}
		result.guardrails = { kind: "guardrails", items };
	}

	if (wanted.has("channels")) {
		const platforms = await connectionStore.listConnections({ agentId });
		result.channels = {
			kind: "channels",
			items: platforms.map((platform) => ({
				id: platform.id,
				name: platform.platform,
				detail: {
					platform: platform.platform,
					status: platform.status,
					agent_id: platform.agentId,
				},
			})),
		};
	}

	return result;
}

export async function listInstalledConnectorIds(
	organizationId: string,
): Promise<string[]> {
	const rows = await listScopedConnectorDefinitions({ organizationId });
	return rows.map((row) => row.key);
}

export function parseKindsParam<T extends string>(
	raw: string | undefined,
	allowed: readonly T[],
): T[] {
	if (!raw?.trim()) return [...allowed];
	const set = new Set(allowed);
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part): part is T => set.has(part as T));
}

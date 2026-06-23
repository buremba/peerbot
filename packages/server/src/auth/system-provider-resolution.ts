/**
 * Resolve system-key model providers and a default pinned model for
 * auto-provisioned agents (builder, owletto-default).
 *
 * Reads `config/providers.json` directly so provisioning is deterministic
 * regardless of whether the gateway module registry is initialized.
 */

import type { ProviderConfigEntry } from "@lobu/core";
import { getErrorMessage } from "@lobu/core";
import { resolveEnv } from "../gateway/auth/mcp/string-substitution";
import { collectProviderModelOptions } from "../gateway/auth/provider-model-options";
import { getModelProviderModules } from "../gateway/modules/module-system";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "../gateway/services/provider-registry-service";
import logger from "../utils/logger";

export interface InstalledProvider {
	providerId: string;
	installedAt: number;
}

export interface ResolvedSystemProviders {
	providers: InstalledProvider[];
	model: string | null;
}

const MODEL_PROVIDER_PREFERENCE = [
	"openai",
	"gemini",
	"groq",
	"mistral",
	"deepseek",
	"cohere",
	"xai",
];

const ZAI_PROVIDER_ID = "z-ai";
const ZAI_SYSTEM_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY"];
export const ZAI_FALLBACK_MODEL = "z-ai/glm-5.2";

const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SYSTEM_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
];
export const CLAUDE_FALLBACK_MODEL = "claude/claude-sonnet-4-6";

function hasZaiSystemKey(): boolean {
	return ZAI_SYSTEM_ENV_VARS.some((v) => !!resolveEnv(v));
}

function hasClaudeSystemKey(): boolean {
	return CLAUDE_SYSTEM_ENV_VARS.some((v) => !!resolveEnv(v));
}

export async function resolveSystemKeyProvidersAndModel(): Promise<ResolvedSystemProviders> {
	const now = Date.now();
	const installed = new Map<string, InstalledProvider>();

	let configs: Record<string, ProviderConfigEntry> = {};
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		configs = await registry.getProviderConfigs();
	} catch (err) {
		logger.warn(
			{ err: getErrorMessage(err) },
			"[system-provider-resolution] providers.json read failed; relying on module registry",
		);
	}
	for (const [providerId, cfg] of Object.entries(configs)) {
		if (cfg.envVarName && resolveEnv(cfg.envVarName)) {
			installed.set(providerId, { providerId, installedAt: now });
		}
	}

	if (hasZaiSystemKey()) {
		installed.set(ZAI_PROVIDER_ID, {
			providerId: ZAI_PROVIDER_ID,
			installedAt: now,
		});
	}

	if (hasClaudeSystemKey()) {
		installed.set(CLAUDE_PROVIDER_ID, {
			providerId: CLAUDE_PROVIDER_ID,
			installedAt: now,
		});
	}

	try {
		for (const m of getModelProviderModules()) {
			if (m.hasSystemKey() && !installed.has(m.providerId)) {
				installed.set(m.providerId, {
					providerId: m.providerId,
					installedAt: now,
				});
			}
		}
	} catch {
		// Registry not available — the providers.json + Claude floor already applies.
	}

	const pickModel = (providerId: string): string | null => {
		const cfg = configs[providerId];
		const dm = cfg?.defaultModel?.trim();
		if (cfg?.envVarName && resolveEnv(cfg.envVarName) && dm) {
			return `${providerId}/${dm}`;
		}
		return null;
	};

	// Prefer Claude (always a real API key) over ZAI and config-declared providers.
	// ZAI is still installed when its key is present; it is only pinned when Claude
	// is absent and no providers.json default resolves.
	let model: string | null = hasClaudeSystemKey()
		? CLAUDE_FALLBACK_MODEL
		: hasZaiSystemKey()
			? ZAI_FALLBACK_MODEL
			: null;
	for (const providerId of MODEL_PROVIDER_PREFERENCE) {
		if (model) break;
		model = pickModel(providerId);
	}
	if (!model) {
		for (const providerId of Object.keys(configs)) {
			model = pickModel(providerId);
			if (model) break;
		}
	}
	if (!model && installed.size > 0) {
		try {
			const optionsByProvider = await collectProviderModelOptions("", "");
			for (const { providerId } of installed.values()) {
				const first = optionsByProvider[providerId]?.[0]?.value?.trim();
				if (first) {
					model = first.startsWith(`${providerId}/`)
						? first
						: `${providerId}/${first}`;
					break;
				}
			}
		} catch {
			// Registry/model fetch unavailable — model may stay null.
		}
	}
	return { providers: [...installed.values()], model };
}

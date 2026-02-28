import type { ModelOption } from "@lobu/core";
import { createLogger, moduleRegistry } from "@lobu/core";

const logger = createLogger("provider-model-options");

export async function collectProviderModelOptions(
  agentId: string,
  userId: string
): Promise<Record<string, ModelOption[]>> {
  const modules = moduleRegistry.getModelProviderModules();

  const results: Record<string, ModelOption[]> = {};

  await Promise.all(
    modules.map(async (mod) => {
      try {
        if (typeof mod.getModelOptions !== "function") {
          results[mod.providerId] = [];
          return;
        }

        const options = await mod.getModelOptions(agentId, userId);
        results[mod.providerId] = Array.isArray(options) ? options : [];
      } catch (error) {
        results[mod.providerId] = [];
        logger.warn(
          {
            providerId: mod.providerId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to collect model options for provider"
        );
      }
    })
  );

  return results;
}

export async function collectModelValues(
  agentId: string,
  userId: string
): Promise<Set<string>> {
  const providerOptions = await collectProviderModelOptions(agentId, userId);
  const values = new Set<string>();

  for (const opts of Object.values(providerOptions)) {
    for (const option of opts) {
      values.add(option.value);
    }
  }

  return values;
}

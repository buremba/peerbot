#!/usr/bin/env bun

import { createLogger, type DatabaseAdapter } from "@peerbot/shared";

const logger = createLogger("dispatcher");

const ENV_PREFIX = "env:";

interface EnvVariable {
  name: string;
  value: string;
}

/**
 * Extracts environment variables from form submission
 * Only processes fields with action_ids starting with "env:"
 */
export function extractEnvVariables(stateValues: any): EnvVariable[] {
  const envVars: EnvVariable[] = [];

  for (const [_blockId, block] of Object.entries(stateValues || {})) {
    for (const [actionId, action] of Object.entries(block as any)) {
      // Check if this action_id indicates an environment variable
      if (actionId.startsWith(ENV_PREFIX)) {
        const value = (action as any).value;

        if (value?.toString().trim()) {
          const envVarName = actionId.slice(ENV_PREFIX.length);
          envVars.push({
            name: envVarName,
            value: value.toString().trim(),
          });

          logger.info(`Found env variable to store: ${envVarName}`);
        }
      }
    }
  }

  return envVars;
}

/**
 * Checks if a form contains any environment variables to store
 */
export function hasEnvVariables(stateValues: any): boolean {
  for (const block of Object.values(stateValues || {})) {
    for (const actionId of Object.keys(block as any)) {
      if (actionId.startsWith(ENV_PREFIX)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Stores environment variables in the database
 */
export async function storeEnvVariables(
  database: DatabaseAdapter,
  userId: string,
  envVars: EnvVariable[],
  channelId?: string,
  repository?: string
): Promise<{ stored: string[]; failed: string[] }> {
  const isChannel = channelId && !channelId.startsWith("D");

  try {
    const result = await database.saveEnvironmentVariables({
      platformUserId: userId,
      channelId: isChannel ? channelId : null,
      repository: repository || null,
      defaultType: isChannel ? "channel" : "user",
      variables: envVars.map((envVar) => ({
        name: envVar.name,
        value: envVar.value,
      })),
    });

    for (const name of result.stored) {
      logger.info(`✅ Stored env variable: ${name} for user ${userId}`);
    }

    if (result.failed.length > 0) {
      logger.error(
        `Failed to store env variables for user ${userId}: ${result.failed.join(", ")}`
      );
    }

    return result;
  } catch (error) {
    logger.error(`Failed to store env variables for user ${userId}:`, error);
    return { stored: [], failed: envVars.map((v) => v.name) };
  }
}

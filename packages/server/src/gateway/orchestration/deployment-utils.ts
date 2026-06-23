import type { ProviderCredentialContext } from "../embedded.js";
import { getOrchestratorModules } from "../modules/module-system.js";
import type { DeploymentInfo } from "./deployment-manager.js";

/**
 * Build environment variables by integrating all registered modules
 */
export async function buildModuleEnvVars(
  agentId: string,
  baseEnv: Record<string, string>,
  context?: ProviderCredentialContext
): Promise<Record<string, string>> {
  let envVars = { ...baseEnv };

  const orchestratorModules = getOrchestratorModules();
  for (const module of orchestratorModules) {
    if (module.buildEnvVars) {
      envVars = await module.buildEnvVars(agentId, envVars, context);
    }
  }

  return envVars;
}

/**
 * Run an async action over `items` in parallel batches of `batchSize`
 * (Promise.allSettled per batch — one failure never blocks the rest of the
 * batch). Rejections are reported through `onError`; the return value is the
 * number of fulfilled actions.
 */
export async function runInBatches<T>(
  items: readonly T[],
  batchSize: number,
  action: (item: T) => Promise<unknown>,
  onError: (item: T, reason: unknown) => void
): Promise<number> {
  let fulfilled = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(action));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result?.status === "fulfilled") {
        fulfilled++;
      } else {
        onError(batch[j] as T, (result as PromiseRejectedResult).reason);
      }
    }
  }
  return fulfilled;
}

export function buildDeploymentInfoSummary({
  deploymentName,
  lastActivity,
  now,
  idleThresholdMinutes,
  veryOldDays,
  replicas,
}: {
  deploymentName: string;
  lastActivity: Date;
  now: number;
  idleThresholdMinutes: number;
  veryOldDays: number;
  replicas: number;
}): DeploymentInfo {
  const minutesIdle = (now - lastActivity.getTime()) / (1000 * 60);
  const daysSinceActivity = minutesIdle / (60 * 24);

  return {
    deploymentName,
    lastActivity,
    minutesIdle,
    daysSinceActivity,
    replicas,
    isIdle: minutesIdle >= idleThresholdMinutes,
    isVeryOld: daysSinceActivity >= veryOldDays,
  };
}

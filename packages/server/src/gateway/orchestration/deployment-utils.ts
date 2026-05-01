import type { ProviderCredentialContext } from "../embedded.js";
import { getOrchestratorModules } from "../modules/module-system.js";
import type {
  DeploymentInfo,
  OrchestratorConfig,
} from "./base-deployment-manager.js";

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

export function getVeryOldThresholdDays(config: OrchestratorConfig): number {
  return config.cleanup?.veryOldDays ?? 7;
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

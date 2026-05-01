import {
  createLogger,
  type ModuleSessionContext,
  moduleRegistry,
  type SessionContext,
  type WorkerModule,
} from "@lobu/core";

const logger = createLogger("worker");

/**
 * Execute an operation on all worker modules with consistent error handling.
 * Errors in individual modules are logged but do not halt iteration.
 */
async function executeForAllModules<T>(
  operation: (module: WorkerModule) => Promise<T>,
  operationName: string
): Promise<T[]> {
  const workerModules = moduleRegistry.getWorkerModules();
  const results: T[] = [];
  for (const module of workerModules) {
    try {
      results.push(await operation(module));
    } catch (error) {
      logger.error(
        `Failed to execute ${operationName} for module ${module.name}:`,
        error
      );
    }
  }
  return results;
}

export async function onSessionStart(
  context: SessionContext
): Promise<SessionContext> {
  // Convert to module session context
  const moduleContext: ModuleSessionContext = {
    userId: context.userId,
    conversationId: context.conversationId || "",
    systemPrompt: context.customInstructions || "",
    workspace: undefined,
  };

  let updatedContext = moduleContext;

  await executeForAllModules(async (module) => {
    updatedContext = await module.onSessionStart(updatedContext);
  }, "onSessionStart");

  // Merge back into original context, mapping systemPrompt back to customInstructions
  return {
    ...context,
    customInstructions:
      updatedContext.systemPrompt || context.customInstructions,
  };
}

/**
 * Configuration for module workspace initialization
 */
interface ModuleWorkspaceConfig {
  workspaceDir: string;
  username: string;
  sessionKey: string;
}

export async function initModuleWorkspace(
  config: ModuleWorkspaceConfig
): Promise<void> {
  await executeForAllModules(
    (module) => module.initWorkspace(config),
    "initWorkspace"
  );
}

export async function collectModuleData(context: {
  workspaceDir: string;
  userId: string;
  conversationId: string;
}): Promise<Record<string, unknown>> {
  const moduleData: Record<string, unknown> = {};

  await executeForAllModules(async (module) => {
    const data = await module.onBeforeResponse(context);
    if (data !== null) {
      moduleData[module.name] = data;
    }
  }, "onBeforeResponse");

  return moduleData;
}

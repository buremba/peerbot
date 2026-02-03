import { createLogger } from "./logger";

const logger = createLogger("modules");

// ============================================================================
// Module Type Definitions
// ============================================================================

export interface ModuleInterface<_TModuleData = unknown> {
  /** Module identifier */
  name: string;

  /** Check if module should be enabled based on environment */
  isEnabled(): boolean;

  /** Initialize module - called once at startup */
  init(): Promise<void>;

  /** Register HTTP endpoints with Express app */
  registerEndpoints(app: any): void;
}

export interface HomeTabModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  /** Render home tab elements */
  renderHomeTab(userId: string): Promise<any[]>;
}

export interface WorkerContext {
  workspaceDir: string;
  userId: string;
  threadId: string;
}

export interface WorkerModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  /** Initialize workspace - called when worker starts session */
  initWorkspace(config: any): Promise<void>;

  /** Called at session start - can modify system prompt */
  onSessionStart(context: ModuleSessionContext): Promise<ModuleSessionContext>;

  /** Called at session end - can add action buttons */
  onSessionEnd(context: ModuleSessionContext): Promise<ActionButton[]>;

  /** Collect module-specific data before sending response. Return null if no data. */
  onBeforeResponse(context: WorkerContext): Promise<TModuleData | null>;
}

export interface OrchestratorModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  /** Build environment variables for worker container */
  buildEnvVars(
    userId: string,
    agentId: string,
    baseEnv: Record<string, string>
  ): Promise<Record<string, string>>;

  /** Get container address for module-specific services */
  getContainerAddress(): string;
}

export interface DispatcherContext<TModuleData = unknown> {
  userId: string;
  channelId: string;
  threadTs: string;
  /** Platform-specific client (e.g., Slack WebClient, WhatsApp BaileysClient) */
  platformClient?: unknown;
  moduleData: TModuleData;
}

export interface DispatcherModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  /** Generate action buttons. Return empty array if none. */
  generateActionButtons(
    context: DispatcherContext<TModuleData>
  ): Promise<ActionButton[]>;

  /** Handle action button clicks. Return true if handled. */
  handleAction(
    actionId: string,
    userId: string,
    agentId: string,
    context: any
  ): Promise<boolean>;

  /** Handle view submission (modal submitted). Optional. */
  handleViewSubmission?(
    viewId: string,
    userId: string,
    values: any,
    privateMetadata: string
  ): Promise<void>;
}

export interface ModuleSessionContext {
  userId: string;
  threadId: string;
  systemPrompt: string;
  workspace?: any;
}

export interface ActionButton {
  text: string;
  action_id: string;
  style?: "primary" | "danger";
  value?: string;
  url?: string;
}

// ============================================================================
// Base Module Implementation
// ============================================================================

/**
 * Base module class that provides default implementations for all optional methods.
 * Modules can extend this class and override only what they need.
 */
export abstract class BaseModule<TModuleData = unknown>
  implements
    WorkerModule<TModuleData>,
    DispatcherModule<TModuleData>,
    HomeTabModule<TModuleData>,
    OrchestratorModule<TModuleData>
{
  abstract name: string;
  abstract isEnabled(): boolean;

  async init(): Promise<void> {
    // Default: no-op
  }

  registerEndpoints(_app: any): void {
    // Default: no-op
  }

  async renderHomeTab(_userId: string): Promise<any[]> {
    // Default: no home tab blocks
    return [];
  }

  async initWorkspace(_config: any): Promise<void> {
    // Default: no-op
  }

  async onSessionStart(
    context: ModuleSessionContext
  ): Promise<ModuleSessionContext> {
    // Default: pass through unchanged
    return context;
  }

  async onSessionEnd(_context: ModuleSessionContext): Promise<ActionButton[]> {
    // Default: no buttons
    return [];
  }

  async onBeforeResponse(_context: WorkerContext): Promise<TModuleData | null> {
    // Default: no data
    return null;
  }

  async buildEnvVars(
    _userId: string,
    _agentId: string,
    baseEnv: Record<string, string>
  ): Promise<Record<string, string>> {
    // Default: pass through unchanged
    return baseEnv;
  }

  getContainerAddress(): string {
    // Default: empty string
    return "";
  }

  async generateActionButtons(
    _context: DispatcherContext<TModuleData>
  ): Promise<ActionButton[]> {
    // Default: no buttons
    return [];
  }

  async handleAction(
    _actionId: string,
    _userId: string,
    _agentId: string,
    _context: any
  ): Promise<boolean> {
    // Default: not handled
    return false;
  }
}

// ============================================================================
// Module Registry
// ============================================================================

export interface IModuleRegistry {
  getDispatcherModules(): DispatcherModule[];
  getHomeTabModules(): HomeTabModule[];
  getWorkerModules(): WorkerModule[];
  getOrchestratorModules(): OrchestratorModule[];
  registerAvailableModules(): Promise<void>;
  initAll(): Promise<void>;
  registerEndpoints(app: any): void;
}

/**
 * Module registry for managing plugin modules across the application.
 *
 * Modules must be explicitly registered by calling `register()` before use.
 * This allows each package (dispatcher, worker) to load only the modules it needs.
 *
 * For production: use the global `moduleRegistry` instance
 * For testing: create a new instance to avoid shared state
 *
 * @example
 * // In gateway/worker
 * import { MyModule } from './my-module';
 * moduleRegistry.register(new MyModule());
 * await moduleRegistry.initAll();
 *
 * @example
 * // In tests
 * const testRegistry = new ModuleRegistry();
 * testRegistry.register(mockModule);
 */
export class ModuleRegistry implements IModuleRegistry {
  private modules: Map<string, ModuleInterface> = new Map();

  register(module: ModuleInterface): void {
    if (module.isEnabled()) {
      this.modules.set(module.name, module);
    }
  }

  /**
   * Automatically discover and register available modules.
   * Tries to import module packages and registers them if available.
   *
   * @param modulePackages - List of module package names to try loading.
   *                         Users can provide custom modules to register.
   *
   * @example
   * // Register custom modules
   * await moduleRegistry.registerAvailableModules([
   *   '@mycompany/slack-module',
   *   '@mycompany/jira-module'
   * ]);
   */
  async registerAvailableModules(modulePackages: string[] = []): Promise<void> {
    for (const packageName of modulePackages) {
      try {
        // Dynamic import to avoid build-time dependencies
        const moduleExports = await import(packageName);

        // Try common export patterns
        const ModuleClass =
          moduleExports.default ||
          Object.values(moduleExports).find(
            (exp) => typeof exp === "function" && exp.name.endsWith("Module")
          );

        if (ModuleClass && typeof ModuleClass === "function") {
          const moduleInstance = new (ModuleClass as any)();
          if (!this.modules.has(moduleInstance.name)) {
            this.register(moduleInstance);
            logger.debug(`${packageName} registered`);
          }
        } else {
          logger.debug(`${packageName}: No module class found in exports`);
        }
      } catch {
        logger.debug(`${packageName} not available`);
      }
    }
  }

  async initAll(): Promise<void> {
    for (const module of this.modules.values()) {
      if (module.init) {
        logger.debug(`Initializing module: ${module.name}`);
        await module.init();
        logger.debug(`Module ${module.name} initialized`);
      }
    }
  }

  registerEndpoints(app: any): void {
    for (const module of this.modules.values()) {
      if (module.registerEndpoints) {
        try {
          module.registerEndpoints(app);
        } catch (error) {
          logger.error(
            `Failed to register endpoints for module ${module.name}:`,
            error
          );
        }
      }
    }
  }

  getHomeTabModules(): HomeTabModule[] {
    return Array.from(this.modules.values()).filter(
      (m): m is HomeTabModule => "renderHomeTab" in m
    );
  }

  getWorkerModules(): WorkerModule[] {
    return Array.from(this.modules.values()).filter(
      (m): m is WorkerModule => "onBeforeResponse" in m
    );
  }

  getOrchestratorModules(): OrchestratorModule[] {
    return Array.from(this.modules.values()).filter(
      (m): m is OrchestratorModule => "buildEnvVars" in m
    );
  }

  getDispatcherModules(): DispatcherModule[] {
    return Array.from(this.modules.values()).filter(
      (m): m is DispatcherModule => "generateActionButtons" in m
    );
  }
}

/**
 * Global registry instance for production use.
 * For testing, create separate instances: `new ModuleRegistry({ skipAutoRegister: true })`
 */
export const moduleRegistry = new ModuleRegistry();

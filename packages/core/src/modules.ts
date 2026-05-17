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

export interface WorkerContext {
  workspaceDir: string;
  userId: string;
  conversationId: string;
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

export interface ModuleSessionContext {
  userId: string;
  conversationId: string;
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
// Module Registry
// ============================================================================

export interface IModuleRegistry {
  register(module: ModuleInterface): void;
  getWorkerModules(): WorkerModule[];
  registerAvailableModules(modulePackages?: string[]): Promise<void>;
  initAll(): Promise<void>;
  registerEndpoints(app: any): void;
  /** Return all registered modules as base ModuleInterface array. */
  getModules(): ModuleInterface[];
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
      logger.debug(`Initializing module: ${module.name}`);
      await module.init();
      logger.debug(`Module ${module.name} initialized`);
    }
  }

  registerEndpoints(app: any): void {
    for (const module of this.modules.values()) {
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

  getWorkerModules(): WorkerModule[] {
    return Array.from(this.modules.values()).filter(
      (m): m is WorkerModule => "onBeforeResponse" in m
    );
  }

  getModules(): ModuleInterface[] {
    return Array.from(this.modules.values());
  }
}

/**
 * Global registry instance for production use.
 * For testing, create separate instances: `new ModuleRegistry()`
 */
export const moduleRegistry = new ModuleRegistry();

import { createLogger } from "./logger";

const logger = createLogger("modules");

// ============================================================================
// Module Type Definitions
// ============================================================================

export interface ModuleInterface {
  /** Module identifier */
  name: string;

  /** Check if module should be enabled based on environment */
  isEnabled(): boolean;

  /** Initialize module - called once at startup */
  init(): Promise<void>;

  /** Register HTTP endpoints with Express app */
  registerEndpoints(app: any): void;
}

// ============================================================================
// Module Registry
// ============================================================================

export interface IModuleRegistry {
  register(module: ModuleInterface): void;
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

  getModules(): ModuleInterface[] {
    return Array.from(this.modules.values());
  }
}

/**
 * Global registry instance for production use.
 * For testing, create separate instances: `new ModuleRegistry()`
 */
export const moduleRegistry = new ModuleRegistry();

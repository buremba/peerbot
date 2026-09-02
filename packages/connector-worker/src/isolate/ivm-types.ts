/**
 * Structural view of the `isolated-vm` surface the bridge uses.
 *
 * Kept separate from the module's own typings so no public worker type
 * depends on `isolated-vm` being installed: `loadIsolatedVm()` narrows the
 * dynamically imported module to this shape at the load boundary, and both
 * `isolated-vm@6` and `isolated-vm@7` satisfy it.
 */

export interface IvmReferenceApplyOptions {
  timeout?: number;
  arguments?: { copy?: boolean };
  result?: { promise?: boolean; copy?: boolean };
}

export interface IvmReference {
  set(name: string, value: unknown): Promise<void>;
  derefInto(): unknown;
  apply(thisArg: unknown, args: unknown[], options?: IvmReferenceApplyOptions): Promise<unknown>;
  applySync(thisArg: unknown, args: unknown[], options?: IvmReferenceApplyOptions): unknown;
}

export interface IvmContext {
  readonly global: IvmReference;
}

export interface IvmScriptRunOptions {
  timeout?: number;
  promise?: boolean;
  copy?: boolean;
}

export interface IvmScript {
  run(context: IvmContext, options?: IvmScriptRunOptions): Promise<unknown>;
}

export interface IvmHeapStatistics {
  total_heap_size: number;
  total_heap_size_executable: number;
  total_physical_size: number;
  total_available_size: number;
  used_heap_size: number;
  heap_size_limit: number;
  malloced_memory: number;
  peak_malloced_memory: number;
  does_zap_garbage: number;
  externally_allocated_size: number;
}

export interface IvmIsolate {
  readonly isDisposed: boolean;
  createContext(): Promise<IvmContext>;
  compileScript(source: string, options?: { filename?: string }): Promise<IvmScript>;
  getHeapStatisticsSync(): IvmHeapStatistics;
  dispose(): void;
}

/** The loaded `isolated-vm` module, narrowed to what the bridge constructs. */
export interface IsolatedVm {
  Isolate: new (options?: { memoryLimit?: number }) => IvmIsolate;
  Reference: new (value: unknown) => IvmReference;
}

/**
 * Minimal type shim for `isolated-vm` so the worker typechecks when the native
 * module is absent locally (it is an optionalDependency whose install is
 * skipped on Node lines without a build). Mirrors the shim in
 * `packages/server/src/types/isolated-vm.d.ts`; the worker's isolate bridge
 * narrows this further to its own structural `IsolatedVm` interface at the
 * load boundary, so no public worker type depends on this module.
 */

declare module 'isolated-vm' {
  export interface IsolateOptions {
    memoryLimit?: number;
  }

  export interface ScriptRunOptions {
    timeout?: number;
    promise?: boolean;
    copy?: boolean;
  }

  export interface ReferenceApplyOptions {
    timeout?: number;
    arguments?: { copy?: boolean };
    result?: { promise?: boolean; copy?: boolean };
  }

  export interface HeapStatistics {
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

  export class Isolate {
    constructor(options?: IsolateOptions);
    readonly isDisposed: boolean;
    createContext(): Promise<Context>;
    compileScript(source: string, options?: { filename?: string }): Promise<Script>;
    getHeapStatisticsSync(): HeapStatistics;
    dispose(): void;
  }

  export class Context {
    readonly global: Reference;
  }

  export class Script {
    run(context: Context, options?: ScriptRunOptions): Promise<unknown>;
  }

  export class Reference<T = unknown> {
    constructor(value: T);
    set(name: string, value: unknown): Promise<void>;
    derefInto(): unknown;
    apply(thisArg: unknown, args: unknown[], options?: ReferenceApplyOptions): Promise<unknown>;
    applySync(thisArg: unknown, args: unknown[], options?: ReferenceApplyOptions): unknown;
  }
}

/**
 * Alias for isolated-vm@7 (Node 26+), installed as `isolated-vm-next` via
 * optionalDependencies. Same API surface as v6 for the bits the bridge uses.
 */
declare module 'isolated-vm-next' {
  export * from 'isolated-vm';
}

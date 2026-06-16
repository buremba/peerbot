/**
 * Connector Runtime
 *
 * Abstract base class that all connectors must implement.
 * Provides the contract for sync (read) and execute (write) operations.
 */

import type {
  ActionContext,
  ActionResult,
  AuthContext,
  AuthResult,
  ConnectorDefinition,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectResult,
  SyncContext,
  SyncResult,
} from './connector-types.js';

/**
 * ConnectorRuntime is the base class for all connectors.
 *
 * Generic parameters:
 * - `C` — checkpoint shape (defaults to `Record<string, unknown>`)
 * - `F` — feed config shape (defaults to `Record<string, unknown>`)
 *
 * Subclasses must:
 * - Set `definition` with connector metadata
 * - Implement `sync()` for feed data ingestion
 *
 * Subclasses may optionally override `execute()` and `authenticate()`; both
 * have safe defaults (action rejected with `{ success: false, ... }`, auth
 * throws). Connectors that don't declare any `actions` in their definition
 * need not override `execute()`.
 *
 * @example
 * ```ts
 * interface MyCheckpoint { last_sync_at?: string }
 * interface MyConfig { label?: string }
 *
 * class GmailConnector extends ConnectorRuntime<MyCheckpoint, MyConfig> {
 *   definition = { key: 'google.gmail', name: 'Gmail', version: '1.0.0', ... };
 *
 *   async sync(ctx: SyncContext<MyCheckpoint, MyConfig>): Promise<SyncResult<MyCheckpoint>> {
 *     // ctx.checkpoint is typed as MyCheckpoint | null — no casts needed
 *     // ctx.config is typed as MyConfig — no casts needed
 *   }
 * }
 * ```
 */
export abstract class ConnectorRuntime<C = Record<string, unknown>, F = Record<string, unknown>> {
  /** Connector definition with metadata, feed schemas, and action schemas */
  abstract readonly definition: ConnectorDefinition;

  /**
   * Sync data from the connected service.
   *
   * Called by the worker when a sync run is executed.
   * Should return events to ingest and an updated checkpoint.
   * Long-running connectors may optionally use `ctx.emitEvents()` and
   * `ctx.updateCheckpoint()` to stream progress before returning.
   *
   * @param ctx - Sync context with feed config, checkpoint, and credentials
   * @returns Events and updated checkpoint
   */
  abstract sync(ctx: SyncContext<C, F>): Promise<SyncResult<C>>;

  /**
   * Execute an action on the connected service.
   *
   * Called either inline (low-risk) or by the worker (high-risk with approval).
   * Default implementation rejects with "Actions not supported" — connectors
   * that don't declare any `actions` in their definition need not override.
   * The `ctx` parameter is part of the public contract (subclasses overriding
   * this method receive the full `ActionContext`); the base impl ignores it.
   *
   * @param ctx - Action context with action key, input, and credentials
   * @returns Action result with output data
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full ActionContext
  async execute(ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  /**
   * Run a read-only query LIVE against the source and return rows — without
   * persisting anything (contrast `sync()`, which emits events). The platform
   * calls this for virtual-feed reads and external-backed derived entities; the
   * connector pushes pagination/sort down. Default implementation throws —
   * connectors that don't serve live reads need not override.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full QueryContext
  async query(ctx: QueryContext<F>): Promise<QueryResult> {
    throw new Error(`${this.definition.key} does not support live queries`);
  }

  /**
   * Contribute entity types by FEDERATING the source's own governed metrics
   * (e.g. Snowflake semantic views, dbt metrics). Returns derived entity types
   * `backing`'d by live SQL over this connection — Lobu stores a pointer +
   * governance, never re-authoring the metric. Default returns `[]` — connectors
   * with no native semantic layer contribute none.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full ReflectContext
  async reflectMetrics(ctx: ReflectContext<F>): Promise<ReflectResult> {
    return [];
  }

  /**
   * Run an interactive authentication flow that produces credentials for the
   * linked auth profile. Invoked during connection creation (or re-auth) when
   * the connector declares an interactive auth method.
   *
   * Stream artifacts (QR, pairing code, redirect URL, status) via `ctx.emit()`
   * and pause on `ctx.awaitSignal()` for UI-delivered input (OAuth callback,
   * form submit). Throw to fail the run; the caught error is surfaced to the
   * UI.
   *
   * Default implementation throws — connectors with non-interactive auth
   * (env_keys, static tokens) don't need to override.
   */
  async authenticate(_ctx: AuthContext): Promise<AuthResult> {
    throw new Error(`${this.definition.key} does not support interactive authentication`);
  }
}

/**
 * Base class for device-bound connectors whose real `sync()`/`execute()` run
 * inside a device bridge (the Owletto Chrome extension or the Lobu Mac/iOS app),
 * not on the server-side worker fleet. The server only ever holds the connector
 * DEFINITION; the cloud-side methods exist purely as safety stubs that throw if a
 * worker without the connector's `requiredCapability` somehow claims the run.
 *
 * Subclasses declare only their `definition` and pass the bridge-only message to
 * `super()`; both `sync()` and `execute()` throw that exact message.
 *
 * @example
 * ```ts
 * export default class ChromeHistoryConnector extends BridgeOnlyConnector {
 *   constructor() {
 *     super('chrome.history runs only on a worker advertising capability "browser.history".');
 *   }
 *   readonly definition: ConnectorDefinition = { ... };
 * }
 * ```
 */
export abstract class BridgeOnlyConnector extends ConnectorRuntime {
  constructor(private readonly bridgeMessage: string) {
    super();
  }

  async sync(): Promise<SyncResult> {
    throw new Error(this.bridgeMessage);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(this.bridgeMessage);
  }
}

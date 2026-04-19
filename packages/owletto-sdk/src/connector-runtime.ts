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
  SyncContext,
  SyncResult,
} from './connector-types.js';

/**
 * ConnectorRuntime is the base class for all connectors.
 *
 * Subclasses must:
 * - Set `definition` with connector metadata
 * - Implement `sync()` for feed data ingestion
 * - Implement `execute()` for action execution
 *
 * @example
 * ```ts
 * class GmailConnector extends ConnectorRuntime {
 *   definition = { key: 'google.gmail', name: 'Gmail', version: '1.0.0', ... };
 *
 *   async sync(ctx: SyncContext): Promise<SyncResult> {
 *     // Fetch threads from Gmail API
 *   }
 *
 *   async execute(ctx: ActionContext): Promise<ActionResult> {
 *     // Create draft, send email, etc.
 *   }
 * }
 * ```
 */
export abstract class ConnectorRuntime {
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
  abstract sync(ctx: SyncContext): Promise<SyncResult>;

  /**
   * Execute an action on the connected service.
   *
   * Called either inline (low-risk) or by the worker (high-risk with approval).
   *
   * @param ctx - Action context with action key, input, and credentials
   * @returns Action result with output data
   */
  abstract execute(ctx: ActionContext): Promise<ActionResult>;

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

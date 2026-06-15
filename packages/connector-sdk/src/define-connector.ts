/**
 * defineConnector — functional authoring sugar over {@link ConnectorRuntime}.
 *
 * Lets a connector be declared as a plain spec with per-feed `sync` and
 * per-action `execute` handlers (plus an optional `authenticate` flow), instead
 * of hand-writing a class that switches on `ctx.feedKey` / `ctx.actionKey`. The
 * feed/action keys are taken from the record keys, so they're never repeated.
 *
 * It LOWERS to a real `ConnectorRuntime` subclass so the existing
 * connector-worker runs it unchanged: `child-runner` detects a connector by
 * looking for a constructor whose prototype has `sync()` and `execute()`, then
 * instantiates it and reads `instance.definition`. The class returned here
 * satisfies that contract exactly.
 *
 * `@lobu/connector-sdk` is externalized at connector compile time, so this
 * function ships as runtime-provided SDK code while the caller's handler
 * closures get bundled into the connector — the spec object (with its
 * `sync`/`execute`/`authenticate` functions) is captured by the returned class.
 *
 * @example
 * ```ts
 * export default defineConnector({
 *   key: 'github', name: 'GitHub', version: '1.0.0',
 *   feeds: { stars: { name: 'Stars', sync: async (ctx) => ({ events, checkpoint }) } },
 *   actions: { star_repo: { name: 'Star', execute: async (ctx) => ({ success: true }) } },
 * });
 * ```
 */

import { ConnectorRuntime } from "./connector-runtime.js";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  AuthContext,
  AuthResult,
  ConnectorDefinition,
  FeedDefinition,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectResult,
  SyncContext,
  SyncResult,
} from "./connector-types.js";

/** A feed's metadata (minus the record-derived `key`) plus its `sync` handler. */
export interface ConnectorFeedSpec<
  C = Record<string, unknown>,
  F = Record<string, unknown>,
> extends Omit<FeedDefinition, "key"> {
  /** Ingest handler for this feed. Called by the worker for a `sync` run. */
  sync(ctx: SyncContext<C, F>): Promise<SyncResult<C>>;
}

/** An action's metadata (minus `key`; `requiresApproval` defaults false) plus its `execute` handler. */
export interface ConnectorActionSpec
  extends Omit<ActionDefinition, "key" | "requiresApproval"> {
  /** Whether the action needs human approval before execution. Defaults to `false`. */
  requiresApproval?: boolean;
  /** Effect handler for this action. Called inline (low-risk) or by the worker. */
  execute(ctx: ActionContext): Promise<ActionResult>;
}

/** Functional connector spec: connector metadata plus handler-bearing feeds/actions. */
export interface ConnectorSpec
  extends Omit<ConnectorDefinition, "feeds" | "actions"> {
  feeds?: Record<string, ConnectorFeedSpec>;
  actions?: Record<string, ConnectorActionSpec>;
  /**
   * Optional interactive auth flow. When provided, lowers to
   * `ConnectorRuntime.authenticate`; when omitted, the connector inherits the
   * base behavior (throws — non-interactive auth needs no handler).
   */
  authenticate?(ctx: AuthContext): Promise<AuthResult>;
  /**
   * Optional live-read handler. When provided, lowers to `ConnectorRuntime.query`
   * — the platform calls it for virtual-feed reads and external-backed derived
   * entities (returns rows, no persistence). Omitted ⇒ live queries unsupported.
   */
  query?(ctx: QueryContext): Promise<QueryResult>;
  /**
   * Optional metric-reflection handler. When provided, lowers to
   * `ConnectorRuntime.reflectMetrics` — contributes entity types federating the
   * source's native governed metrics. Omitted ⇒ no contributions.
   */
  reflectMetrics?(ctx: ReflectContext): Promise<ReflectResult>;
}

/** Constructor shape the connector-worker's `child-runner` detects and instantiates. */
export type ConnectorClass = new () => ConnectorRuntime;

/** Strip handler closures and derive `key` from the record key — keeps the definition serializable. */
function buildDefinition(spec: ConnectorSpec): ConnectorDefinition {
  const definition: ConnectorDefinition = {
    key: spec.key,
    name: spec.name,
    version: spec.version,
    description: spec.description,
    authSchema: spec.authSchema,
    optionsSchema: spec.optionsSchema,
    faviconDomain: spec.faviconDomain,
    mcpConfig: spec.mcpConfig,
    openapiConfig: spec.openapiConfig,
    requiredCapability: spec.requiredCapability,
    runtime: spec.runtime,
  };

  if (spec.feeds) {
    definition.feeds = Object.fromEntries(
      Object.entries(spec.feeds).map(([key, feed]): [string, FeedDefinition] => [
        key,
        {
          key,
          name: feed.name,
          description: feed.description,
          requiredScopes: feed.requiredScopes,
          displayNameTemplate: feed.displayNameTemplate,
          configSchema: feed.configSchema,
          userManaged: feed.userManaged,
          eventKinds: feed.eventKinds,
        },
      ]),
    );
  }

  if (spec.actions) {
    definition.actions = Object.fromEntries(
      Object.entries(spec.actions).map(
        ([key, action]): [string, ActionDefinition] => [
          key,
          {
            key,
            name: action.name,
            description: action.description,
            requiresApproval: action.requiresApproval ?? false,
            annotations: action.annotations,
            inputSchema: action.inputSchema,
            outputSchema: action.outputSchema,
          },
        ],
      ),
    );
  }

  return definition;
}

/**
 * Build a {@link ConnectorRuntime} subclass from a functional spec. The default
 * export of a `.connector.ts` should be the returned class.
 */
export function defineConnector(spec: ConnectorSpec): ConnectorClass {
  const definition = buildDefinition(spec);

  return class extends ConnectorRuntime {
    readonly definition = definition;

    async sync(ctx: SyncContext): Promise<SyncResult> {
      const feed = spec.feeds?.[ctx.feedKey];
      if (!feed) {
        throw new Error(
          `Connector '${spec.key}' has no sync handler for feed '${ctx.feedKey}'`,
        );
      }
      return feed.sync(ctx);
    }

    async execute(ctx: ActionContext): Promise<ActionResult> {
      const action = spec.actions?.[ctx.actionKey];
      if (!action) {
        return {
          success: false,
          error: `Connector '${spec.key}' has no action handler for '${ctx.actionKey}'`,
        };
      }
      return action.execute(ctx);
    }

    async authenticate(ctx: AuthContext): Promise<AuthResult> {
      if (!spec.authenticate) {
        return super.authenticate(ctx);
      }
      return spec.authenticate(ctx);
    }

    async query(ctx: QueryContext): Promise<QueryResult> {
      if (!spec.query) {
        return super.query(ctx);
      }
      return spec.query(ctx);
    }

    async reflectMetrics(ctx: ReflectContext): Promise<ReflectResult> {
      if (!spec.reflectMetrics) {
        return super.reflectMetrics(ctx);
      }
      return spec.reflectMetrics(ctx);
    }
  };
}

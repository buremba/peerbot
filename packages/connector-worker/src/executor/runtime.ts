import type { Checkpoint, Content, FeedOptions, SessionState } from '@lobu/connector-sdk';
import type { ExecutionHooks, FeedSyncResult, SyncContext, SyncExecutor } from './interface.js';
import { SubprocessExecutor } from './subprocess.js';

interface ConnectorOAuthCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

interface BaseExecutionParams {
  compiledCode: string;
  env?: Record<string, string | undefined>;
  connectionCredentials?: Record<string, string | undefined> | null;
  sessionState?: SessionState | null;
  credentials?: ConnectorOAuthCredentials | null;
  apiType?: 'api' | 'browser';
  executor?: SyncExecutor;
  hooks?: ExecutionHooks;
}

interface SyncConnectorExecutionParams extends BaseExecutionParams {
  mode: 'sync';
  config?: Record<string, unknown> | null;
  checkpoint?: Checkpoint | null;
  feedKey?: string | null;
  entityIds?: number[] | null;
}

interface ActionConnectorExecutionParams extends BaseExecutionParams {
  mode: 'action';
  actionKey: string;
  actionInput?: Record<string, unknown> | null;
  checkpoint?: Checkpoint | null;
}

interface AuthConnectorExecutionParams extends BaseExecutionParams {
  mode: 'authenticate';
  /** Connector-specific auth input (rare). */
  config?: Record<string, unknown> | null;
  /** Existing credentials for re-auth flows. */
  previousCredentials?: Record<string, unknown> | null;
}

type ConnectorExecutionParams =
  | SyncConnectorExecutionParams
  | ActionConnectorExecutionParams
  | AuthConnectorExecutionParams;

function mergeExecutionEnv(
  env?: Record<string, string | undefined>,
  connectionCredentials?: Record<string, string | undefined> | null
): Record<string, string | undefined> {
  return {
    ...(env ?? {}),
    ...(connectionCredentials ?? {}),
  };
}

function mergeExecutionSessionState(
  sessionState?: SessionState | null,
  credentials?: ConnectorOAuthCredentials | null
): SessionState | null {
  if (!sessionState && !credentials) return null;

  return {
    ...(sessionState ?? {}),
    ...(credentials ? { oauth: credentials } : {}),
  };
}

function buildConnectorExecutionContext(params: ConnectorExecutionParams): SyncContext {
  const env = mergeExecutionEnv(params.env, params.connectionCredentials);
  const sessionState = mergeExecutionSessionState(params.sessionState, params.credentials);

  if (params.mode === 'action') {
    return {
      options: {
        __action_key: params.actionKey,
        __action_input: params.actionInput ?? {},
        ...((params.actionInput ?? {}) as Record<string, unknown>),
      } as FeedOptions,
      checkpoint: (params.checkpoint ?? null) as Checkpoint | null,
      env,
      sessionState,
      apiType: params.apiType ?? 'api',
    };
  }

  if (params.mode === 'authenticate') {
    return {
      options: {
        __auth_mode: true,
        __auth_config: params.config ?? {},
        __auth_previous_credentials: params.previousCredentials ?? null,
      } as FeedOptions,
      checkpoint: null,
      env,
      sessionState,
      apiType: params.apiType ?? 'api',
    };
  }

  return {
    options: {
      ...(params.config ?? {}),
      __feed_key: params.feedKey,
      __entity_ids: params.entityIds ?? [],
    } as FeedOptions,
    checkpoint: (params.checkpoint ?? null) as Checkpoint | null,
    env,
    sessionState,
    apiType: params.apiType ?? 'api',
  };
}

export async function executeCompiledConnector(
  params: ConnectorExecutionParams
): Promise<FeedSyncResult> {
  const executor = params.executor ?? new SubprocessExecutor();
  const context = buildConnectorExecutionContext(params);
  return executor.execute(params.compiledCode, context, params.hooks);
}

export function normalizeEventEnvelope(event: Record<string, any>): Content {
  const originType = event.origin_type;
  const rawDate = event.occurred_at ?? event.published_at;
  return {
    origin_id: event.origin_id ?? event.external_id,
    payload_text: event.payload_text ?? event.content ?? '',
    title: event.title,
    author_name: event.author_name ?? event.author,
    source_url: event.source_url ?? event.url ?? '',
    occurred_at: rawDate ? new Date(rawDate) : new Date(),
    origin_type: originType,
    semantic_type: event.semantic_type ?? originType,
    score: typeof event.score === 'number' ? event.score : 0,
    origin_parent_id: event.origin_parent_id ?? event.parent_external_id ?? null,
    metadata: event.metadata ?? {},
  };
}

export function getActionOutput(result: FeedSyncResult): Record<string, unknown> {
  return (result.contents[0]?.metadata ?? {}) as Record<string, unknown>;
}

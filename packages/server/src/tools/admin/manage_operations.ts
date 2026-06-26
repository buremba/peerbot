/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb, pgBigintArray, pgTextArray } from '../../db/client';
import type { Env } from '../../index';
import { callTool as callProxyTool } from '../../mcp-proxy/client';
import { resolveCredentialsByConnectionId } from '../../mcp-proxy/credential-resolver';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { resolveActionMode } from '../../operations/action-modes';
import { getOperationForConnection, listOperations } from '../../operations/connector-operations';
import type { AvailableOperation, OperationDescriptor } from '../../operations/types';
import { resolveConnectorCode } from '../../utils/ensure-connector-installed';
import { resolveExecutionAuth } from '../../utils/execution-context';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { createConnectorOperationRun } from '../../runs/queue-service';
import { dispatchChromeActionToExtension } from '../../worker-api/dispatch-chrome-action';
import { buildEventPermalink } from '../../utils/url-builder';
import { trackWatcherReaction } from '../../utils/watcher-reactions';
import type { ToolContext } from '../registry';
import { getOrgUrlContext } from '../view-urls';
import { action, defineActionTool } from './action-tool';
import {
  MANAGE_AGENTS_ACTION_KEY,
  type ManageAgentsProposal,
  applyManageAgentsProposal,
} from './manage_agents';
import {
  ENTITY_FIELD_CHANGE_ACTION_KEY,
  type EntityFieldChangeProposal,
  applyEntityFieldChangeProposal,
} from './entity-field-approval';
import { PaginationFields } from './schemas/common-fields';
import { getErrorMessage } from "@lobu/core";

const BackendLiteral = Type.Union([
  Type.Literal('local_action'),
  Type.Literal('mcp_tool'),
  Type.Literal('http_operation'),
]);

const KindLiteral = Type.Union([Type.Literal('read'), Type.Literal('write')]);

const ListAvailableAction = Type.Object({
  action: Type.Literal('list_available'),
  connector_key: Type.Optional(Type.String()),
  connection_id: Type.Optional(Type.Number()),
  entity_id: Type.Optional(Type.Number()),
  kind: Type.Optional(KindLiteral),
  backend: Type.Optional(BackendLiteral),
  include_input_schema: Type.Optional(Type.Boolean({ default: true })),
  include_output_schema: Type.Optional(Type.Boolean({ default: false })),
  ...PaginationFields,
});

const ExecuteAction = Type.Object({
  action: Type.Literal('execute'),
  connection_id: Type.Number({ description: 'Connection ID to execute on' }),
  operation_key: Type.String({ description: 'Connector-local operation key' }),
  input: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Operation input' })),
  watcher_source: Type.Optional(
    Type.Object({
      watcher_id: Type.Number(),
      window_id: Type.Number(),
    })
  ),
});

const ListRunsAction = Type.Object({
  action: Type.Literal('list_runs'),
  connection_id: Type.Optional(Type.Number()),
  connection_ids: Type.Optional(Type.Array(Type.Number())),
  feed_ids: Type.Optional(Type.Array(Type.Number())),
  device_worker_id: Type.Optional(Type.String()),
  operation_key: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  approval_status: Type.Optional(Type.String()),
  /** Filter by run_type. Omit to list every run type (sync, action, auth, …). */
  run_types: Type.Optional(Type.Array(Type.String())),
  /** Filter watcher runs by watcher id(s). */
  watcher_ids: Type.Optional(Type.Array(Type.Number())),
  /** Keyset cursor: return runs ordered before (before_created_at, before_id). */
  before_id: Type.Optional(Type.Number()),
  before_created_at: Type.Optional(Type.String()),
  ...PaginationFields,
});

const GetRunAction = Type.Object({
  action: Type.Literal('get_run'),
  run_id: Type.Number(),
});

const ApproveAction = Type.Object({
  action: Type.Literal('approve'),
  run_id: Type.Number(),
  input: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const RejectAction = Type.Object({
  action: Type.Literal('reject'),
  run_id: Type.Number(),
  reason: Type.Optional(Type.String()),
});


type ManageOperationsResult =
  | { error: string }
  | {
      action: 'list_available';
      operations: Array<Record<string, unknown>> | AvailableOperation[];
      total: number;
      limit: number;
      offset: number;
    }
  | {
      action: 'execute';
      run_id: number;
      event_id?: number;
      approval_url?: string;
      status: 'pending_approval';
      message: string;
    }
  | {
      action: 'execute';
      run_id: number;
      status: 'completed';
      output: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | { action: 'execute'; run_id: number; status: 'failed'; error_message: string }
  | {
      action: 'execute';
      run_id: number;
      status: 'timeout';
      error_message: string;
    }
  | {
      action: 'list_runs';
      runs: any[];
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    }
  | { action: 'get_run'; run: any }
  | { action: 'approve'; approved: true; run_id: number; event_id?: number; message: string }
  | { action: 'reject'; rejected: true; run_id: number; event_id?: number };


type InlineExecutionResult =
  | { status: 'completed'; output: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: 'failed'; error_message: string };

type ConnectionRow = {
  id: number;
  connector_key: string;
  status: string;
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
  display_name: string | null;
  config: Record<string, unknown> | null;
  name: string;
};

const manageOperationsTool = defineActionTool('manage_operations', {
  list_available: action(ListAvailableAction, handleListAvailable),
  execute: action(ExecuteAction, handleExecute),
  list_runs: action(ListRunsAction, handleListRuns),
  get_run: action(GetRunAction, handleGetRun),
  approve: action(ApproveAction, handleApprove),
  reject: action(RejectAction, handleReject),
});

export const ManageOperationsSchema = manageOperationsTool.schema;
export const manageOperations = manageOperationsTool.run;

// Update the run to failed status and return the error result in one call.
async function failRunInline(
  runId: number,
  organizationId: string,
  errorMsg: string
): Promise<InlineExecutionResult> {
  const sql = getDb();
  await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMsg} WHERE id = ${runId} AND organization_id = ${organizationId}`;
  return { status: 'failed', error_message: errorMsg };
}

// Update the run to completed status and return the output in one call.
async function completeRunInline(
  runId: number,
  organizationId: string,
  output: Record<string, unknown>
): Promise<InlineExecutionResult> {
  const sql = getDb();
  await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
  return { status: 'completed', output };
}

/**
 * Build the `config` an inline connector action sees. Precedence low → high:
 * process env, then resolved connection credentials, then the connection's own
 * `config` (authoritative — mirrors the sync path's
 * `mergeEnv(env, connectionCredentials, feedConfig)`). Connection config is
 * last so an action can read e.g. a Deliveroo connection's `restaurants_url`.
 * Exported for unit testing the merge precedence.
 */
export function buildActionConfig(
  envStrings: Record<string, string | undefined>,
  connectionCredentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return { ...envStrings, ...connectionCredentials, ...(connectionConfig ?? {}) };
}

async function executeLocalActionInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>,
  env: Env,
  abortSignal?: AbortSignal
): Promise<InlineExecutionResult> {
  const sql = getDb();

  const runRows =
    await sql`SELECT connector_version FROM runs WHERE id = ${runId} AND organization_id = ${organizationId} AND run_type = 'action' LIMIT 1`;
  const connectorVersion = (runRows[0] as { connector_version: string | null } | undefined)
    ?.connector_version;

  const compiledRows = connectorVersion
    ? await sql`SELECT compiled_code FROM connector_versions WHERE connector_key = ${connection.connector_key} AND version = ${connectorVersion} LIMIT 1`
    : await sql`SELECT compiled_code FROM connector_versions WHERE connector_key = ${connection.connector_key} ORDER BY created_at DESC LIMIT 1`;

  let compiledCode: string;
  try {
    const rawCode =
      (compiledRows[0] as { compiled_code: string | null } | undefined)?.compiled_code ?? null;
    compiledCode = await resolveConnectorCode(connection.connector_key, rawCode);
  } catch (err) {
    return failRunInline(runId, organizationId, getErrorMessage(err));
  }

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId,
    connectionId: connection.id,
    authProfileId: Number(connection.auth_profile_id) || null,
    appAuthProfileId: Number(connection.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { run_id: runId },
    logMessage: 'Failed to resolve action credentials',
  });

  try {
    const { executeCompiledConnector } = await import(
      '@lobu/connector-worker/executor/runtime'
    );
    const envStrings = Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === 'string')
    );
    const result = await executeCompiledConnector({
      compiledCode,
      job: {
        mode: 'action',
        actionKey:
          operation.backend_config.backend === 'local_action'
            ? operation.backend_config.actionKey
            : operation.operation_key,
        actionInput,
        // Merge the connection's own config (e.g. a Deliveroo connection's
        // `restaurants_url`) into the action config, the way a sync merges its
        // feed config. See buildActionConfig for the precedence.
        config: buildActionConfig(
          envStrings,
          connectionCredentials,
          connection.config as Record<string, unknown> | null
        ),
        env: envStrings,
        sessionState,
        credentials,
      },
      hooks: {
        // Let an inline connector action drive the paired Owletto Chrome
        // extension (the office-bot Deliveroo connector scrapes restaurant
        // search + menu pages this way). The connector calls
        // `ctx.sessionState.chrome_dispatcher.dispatch(...)`; that surfaces here
        // and we resolve a chrome worker + run the device action in-process,
        // the same bridge syncs use over HTTP.
        onChromeDispatch: async (actionKey, actionInput) => {
          const dispatchResult = await dispatchChromeActionToExtension({
            organizationId,
            actionKey,
            actionInput,
            parentRunId: runId,
            abortSignal,
          });
          if (dispatchResult.status !== 'completed') {
            throw new Error(
              dispatchResult.error_message ??
                `chrome action '${actionKey}' ${dispatchResult.status}`
            );
          }
          return dispatchResult.output ?? {};
        },
      },
    });

    if (result.mode !== 'action') {
      throw new Error(`Expected action result, got mode=${result.mode}`);
    }
    return completeRunInline(runId, organizationId, result.output);
  } catch (error) {
    return failRunInline(runId, organizationId, getErrorMessage(error));
  }
}

async function executeMcpToolInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>
): Promise<InlineExecutionResult> {
  if (operation.backend_config.backend !== 'mcp_tool') {
    return { status: 'failed', error_message: 'Invalid MCP operation backend config' };
  }

  const result = await callProxyTool(
    connection.connector_key,
    {
      upstream_url: operation.backend_config.upstreamUrl,
      tool_prefix: '',
    },
    organizationId,
    operation.backend_config.toolName,
    actionInput
  );

  if (result.isError) {
    const errorText =
      (result.content as Array<{ type: string; text?: string }>).find(
        (item) => item?.type === 'text'
      )?.text ?? 'Upstream MCP error';
    return failRunInline(runId, organizationId, errorText);
  }

  return completeRunInline(runId, organizationId, { content: result.content } as Record<string, unknown>);
}

function buildResolvedUrl(
  serverUrl: string,
  pathTemplate: string,
  input: Record<string, unknown>
): URL {
  const pathValues =
    input.path && typeof input.path === 'object' ? (input.path as Record<string, unknown>) : {};
  const queryValues =
    input.query && typeof input.query === 'object' ? (input.query as Record<string, unknown>) : {};
  let path = pathTemplate;
  for (const [key, value] of Object.entries(pathValues)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }

  const url = new URL(path, serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
  for (const [key, value] of Object.entries(queryValues)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function pickInterestingHeaders(headers: Headers): Record<string, unknown> | undefined {
  const interestingHeaders = ['content-type', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'link'];
  const values = Object.fromEntries(
    interestingHeaders
      .map((header) => [header, headers.get(header)])
      .filter(([, value]) => value !== null)
  );
  return Object.keys(values).length > 0 ? values : undefined;
}

async function executeHttpOperationInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>
): Promise<InlineExecutionResult> {
  const sql = getDb();
  if (operation.backend_config.backend !== 'http_operation') {
    return { status: 'failed', error_message: 'Invalid HTTP operation backend config' };
  }

  const credentials = await resolveCredentialsByConnectionId(connection.id, organizationId);
  if (!credentials) {
    return {
      status: 'failed',
      error_message: `No active OAuth credentials found for '${connection.connector_key}'.`,
    };
  }

  const headersInput =
    actionInput.headers && typeof actionInput.headers === 'object'
      ? (actionInput.headers as Record<string, unknown>)
      : {};
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersInput)) {
    if (/^(authorization|host)$/i.test(key) || value === undefined || value === null) continue;
    headers.set(key, String(value));
  }
  headers.set('Authorization', `${credentials.tokenType} ${credentials.accessToken}`);

  const body = actionInput.body;
  let requestBody: string | undefined;
  if (body !== undefined) {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers.has('content-type') && typeof body === 'object' && body !== null) {
      headers.set('content-type', 'application/json');
    }
  }

  const url = buildResolvedUrl(
    operation.backend_config.serverUrl,
    operation.backend_config.pathTemplate,
    actionInput
  );

  try {
    const response = await fetch(url, {
      method: operation.backend_config.method,
      headers,
      body: ['GET', 'HEAD'].includes(operation.backend_config.method) ? undefined : requestBody,
      redirect: 'manual',
    });

    const text = await response.text();
    let parsedBody: unknown = text;
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      // Keep as text
    }
    const output = { body: parsedBody } as Record<string, unknown>;
    const metadata: Record<string, unknown> = {
      http_status: response.status,
    };
    const headerMetadata = pickInterestingHeaders(response.headers);
    if (headerMetadata) {
      metadata.response_headers = headerMetadata;
      const rateLimits = Object.fromEntries(
        Object.entries(headerMetadata).filter(([key]) => key.startsWith('x-ratelimit'))
      );
      if (Object.keys(rateLimits).length > 0) metadata.rate_limits = rateLimits;
      if (headerMetadata.link) metadata.pagination = { link: headerMetadata.link };
    }

    if (!response.ok) {
      const errorText = typeof parsedBody === 'string' ? parsedBody : `HTTP ${response.status}`;
      await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), action_output = ${sql.json(output)}, error_message = ${errorText} WHERE id = ${runId} AND organization_id = ${organizationId}`;
      return { status: 'failed', error_message: errorText };
    }

    await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'completed', output, metadata };
  } catch (error) {
    return failRunInline(runId, organizationId, getErrorMessage(error));
  }
}

async function executeOperationInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>,
  env: Env,
  abortSignal?: AbortSignal
): Promise<InlineExecutionResult> {
  if (operation.backend === 'local_action') {
    return executeLocalActionInline(
      runId,
      organizationId,
      connection,
      operation,
      actionInput,
      env,
      abortSignal
    );
  }
  if (operation.backend === 'mcp_tool') {
    return executeMcpToolInline(runId, organizationId, connection, operation, actionInput);
  }
  return executeHttpOperationInline(runId, organizationId, connection, operation, actionInput);
}

async function handleListAvailable(
  args: Static<typeof ListAvailableAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  const result = await listOperations({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key,
    connectionId: args.connection_id,
    entityId: args.entity_id,
    kind: args.kind,
    backend: args.backend,
    includeInputSchema: args.include_input_schema ?? true,
    includeOutputSchema: args.include_output_schema ?? false,
    limit: args.limit,
    offset: args.offset,
  });

  return {
    action: 'list_available',
    operations: result.operations,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

// Poll `runs` until status flips to completed/failed/timeout or we hit
// our deadline. Used by handleExecute when the connector is device-
// bound — the gateway can't execute inline; it inserts a pending run
// and waits for the device worker (chrome extension / mac bridge /
// etc.) to claim, run, and POST /api/workers/complete-action.
//
// Deadline strategy: two phases.
//
//   - PRE-CLAIM (status='pending'): how long the device has to even
//     pick the run up. The chrome extension polls /poll every 5s; we
//     allow up to QUEUE_BUDGET_MS for it to arrive.
//
//   - POST-CLAIM (status='running'): how long the device has to
//     execute, after it claimed the run. The chrome extension's own
//     per-run watchdog (tools.js RUN_TIMEOUT_MS=90s) caps this; we
//     allow that + buffer so the gateway never times out a
//     legitimately-running tool.
//
// Without the two-phase split, a slow poll cycle (worker offline for
// 20-30s) could exhaust a flat-100s deadline before the worker even
// claimed the run, marking it timeout while the worker was about to
// pick it up.
export async function waitForDeviceActionRun(
  runId: number,
  organizationId: string,
  /**
   * Abort the wait early (e.g. a watcher reaction hit its wall-clock budget).
   * On abort we stop polling and finalize the run as `timeout` so the orphaned
   * poll loop and any in-flight device work don't leak past the caller.
   */
  abortSignal?: AbortSignal,
): Promise<{
  status: 'completed' | 'failed' | 'timeout';
  output?: Record<string, unknown>;
  error_message?: string;
}> {
  const sql = getDb();
  const QUEUE_BUDGET_MS = 60_000; // generous: device may be sleeping
  const POST_CLAIM_BUDGET_MS = 95_000; // matches extension's 90s + 5s buffer
  const POLL_MS = 500;
  const queueDeadline = Date.now() + QUEUE_BUDGET_MS;
  let claimedAtMs: number | null = null;

  while (true) {
    const rows = (await sql`
      SELECT status, action_output, error_message, claimed_at
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
      claimed_at: Date | string | null;
    }>;
    const row = rows[0];
    if (!row) {
      return {
        status: 'failed',
        error_message: `Run ${runId} disappeared from runs table while waiting.`,
      };
    }
    if (row.status === 'completed') {
      return {
        status: 'completed',
        output: (row.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (row.status === 'failed' || row.status === 'timeout') {
      return {
        status: row.status as 'failed' | 'timeout',
        error_message: row.error_message ?? `Run ${runId} ${row.status}`,
      };
    }
    // Still pending or running. Check the right deadline for this phase.
    if (row.claimed_at && claimedAtMs == null) {
      claimedAtMs =
        row.claimed_at instanceof Date
          ? row.claimed_at.getTime()
          : new Date(row.claimed_at).getTime();
    }
    // Caller aborted (e.g. reaction timeout) — stop polling and let the
    // timeout finalization below mark the run, so we don't leak this loop.
    if (abortSignal?.aborted) break;
    const now = Date.now();
    if (claimedAtMs != null) {
      if (now - claimedAtMs >= POST_CLAIM_BUDGET_MS) break;
    } else {
      if (now >= queueDeadline) break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Atomic timeout finalization. The WHERE clause matches only non-
  // terminal states; if the worker raced us and posted completion
  // between our last SELECT and this UPDATE, this UPDATE is a no-op
  // and we re-read the row to surface the worker's verdict.
  const updated = (await sql`
    UPDATE runs
    SET status = 'timeout',
        completed_at = current_timestamp,
        error_message = ${'waitForDeviceActionRun: device worker did not complete in time'}
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND status IN ('pending', 'running')
    RETURNING id
  `) as Array<{ id: number }>;

  if (updated.length === 0) {
    // Worker won the race. Re-read to return whatever it actually said.
    const finalRows = (await sql`
      SELECT status, action_output, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
    }>;
    const final = finalRows[0];
    if (final?.status === 'completed') {
      return {
        status: 'completed',
        output: (final.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (final?.status === 'failed') {
      return {
        status: 'failed',
        error_message: final.error_message ?? `Run ${runId} failed`,
      };
    }
    // Shouldn't reach here, but fall through to timeout.
  }

  return {
    status: 'timeout',
    error_message:
      claimedAtMs != null
        ? `Run ${runId} claimed but the device worker didn't finish within ${POST_CLAIM_BUDGET_MS}ms.`
        : `Run ${runId} was never claimed within ${QUEUE_BUDGET_MS}ms — the chrome-extension / device worker may be offline.`,
  };
}

async function handleExecute(
  args: Static<typeof ExecuteAction>,
  ctx: ToolContext,
  env: Env
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const resolved = await getOperationForConnection(
    ctx.organizationId,
    args.connection_id,
    args.operation_key
  );
  if (!resolved) {
    return { error: `Invalid operation_key '${args.operation_key}' for this connection.` };
  }

  const { connection, operation } = resolved;
  if (connection.status !== 'active') {
    return { error: `Connection is ${connection.status}, must be active` };
  }

  const input = args.input ?? {};
  const mode = resolveActionMode(operation, connection.config);
  if (mode === 'disabled') {
    return {
      error: `Operation '${operation.operation_key}' is disabled on this connection.`,
    };
  }
  const shouldQueue = mode === 'approval';

  // Detect device-bound connector by reading the connector definition's
  // `runtime` field. When set (e.g. chrome-extension, macos, ios), the
  // connector's execute() lives on a device worker, not on the gateway.
  // Inline execution would hit the BRIDGE_ONLY throw. Instead, create a
  // status='pending' run + wait for the worker to claim, complete it,
  // and persist action_output via /api/workers/complete-action.
  const defRows = (await sql`
    SELECT runtime FROM connector_definitions
    WHERE key = ${connection.connector_key}
      AND organization_id = ${ctx.organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `) as Array<{ runtime: Record<string, unknown> | null }>;
  const isDeviceBound = defRows[0]?.runtime != null;

  const approvalMode: 'inline' | 'queued' | 'device' = shouldQueue
    ? 'queued'
    : isDeviceBound
      ? 'device'
      : 'inline';

  const runId = await createConnectorOperationRun({
    organizationId: ctx.organizationId,
    connectionId: connection.id,
    connectorKey: connection.connector_key,
    operationKey: operation.operation_key,
    operationInput: input,
    approvalMode,
    requireCompiledCode: operation.backend === 'local_action',
  });

  if (args.watcher_source) {
    await trackWatcherReaction({
      organizationId: ctx.organizationId,
      watcherId: args.watcher_source.watcher_id,
      windowId: args.watcher_source.window_id,
      reactionType: 'action_executed',
      toolName: 'manage_operations',
      toolArgs: {
        operation_key: args.operation_key,
        connection_id: args.connection_id,
        input,
      },
      runId,
    });
  }

  if (shouldQueue) {
    const feedRows = await sql`
      SELECT entity_ids FROM feeds
      WHERE connection_id = ${args.connection_id} AND deleted_at IS NULL AND entity_ids IS NOT NULL
      LIMIT 1
    `;
    const rawEntityIds =
      (feedRows[0] as { entity_ids: string | number[] } | undefined)?.entity_ids ?? null;
    const entityIdsLiteral = rawEntityIds
      ? typeof rawEntityIds === 'string'
        ? rawEntityIds
        : `{${(rawEntityIds as number[]).join(',')}}`
      : null;
    const event = await insertEvent({
      entityIds:
        entityIdsLiteral && typeof entityIdsLiteral === 'string'
          ? entityIdsLiteral.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
          : [],
      organizationId: ctx.organizationId,
      originId: `run_${runId}_pending`,
      title: `${operation.name} — pending approval`,
      content: `Agent requested operation: ${operation.name}`,
      semanticType: 'operation',
      connectorKey: connection.connector_key,
      connectionId: args.connection_id,
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInputSchema:
        (operation.input_schema as Record<string, unknown> | undefined) ?? null,
      interactionInput: input,
      metadata: {
        operation_key: operation.operation_key,
        operation_name: operation.name,
        action_key: operation.operation_key,
        action_name: operation.name,
        operation_input: input,
        action_input: input,
        input_schema: operation.input_schema ?? null,
        status: 'pending_approval',
        connection_name: connection.display_name ?? connection.connector_key,
        run_id: runId,
      },
      authorName: ctx.clientId ?? 'agent',
    });
    const eventId = Number(event.id);
    const { ownerSlug: orgSlug, baseUrl } = await getOrgUrlContext(ctx);
    const approvalUrl =
      orgSlug && baseUrl ? buildEventPermalink(orgSlug, eventId, baseUrl) : undefined;

    notifyActionApprovalNeeded({
      orgId: ctx.organizationId,
      runId,
      actionKey: operation.operation_key,
      connectionName: connection.display_name ?? connection.connector_key,
      eventId,
      approvalUrl,
    }).catch((error) => logger.error(error, 'Failed to send operation approval notification'));

    return {
      action: 'execute',
      run_id: runId,
      event_id: eventId,
      approval_url: approvalUrl,
      status: 'pending_approval',
      message: `Operation '${operation.name}' requires approval. Share the approval_url with the user to confirm.`,
    };
  }

  // Device-bound branch: the run is pending; a device worker (chrome
  // extension, mac bridge, ...) will claim it via /api/workers/poll and
  // post completion to /api/workers/complete-action. Poll runs.status
  // here until it flips to completed/failed/timeout, or we hit the
  // device-action timeout. Returns action_output on success.
  if (approvalMode === 'device') {
    const result = await waitForDeviceActionRun(
      runId,
      ctx.organizationId,
      ctx.abortSignal
    );
    if (result.status === 'completed') {
      return {
        action: 'execute',
        run_id: runId,
        status: 'completed',
        output: result.output ?? {},
      };
    }
    if (result.status === 'timeout') {
      return {
        action: 'execute',
        run_id: runId,
        status: 'timeout',
        error_message: result.error_message ?? 'Device action run timed out.',
      };
    }
    return {
      action: 'execute',
      run_id: runId,
      status: 'failed',
      error_message: result.error_message ?? 'Device action run failed.',
    };
  }

  const result = await executeOperationInline(
    runId,
    ctx.organizationId,
    connection,
    operation,
    input,
    env,
    ctx.abortSignal
  );
  if (result.status === 'completed') {
    return {
      action: 'execute',
      run_id: runId,
      status: 'completed',
      output: result.output,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  }
  return {
    action: 'execute',
    run_id: runId,
    status: 'failed',
    error_message: result.error_message,
  };
}

async function handleListRuns(
  args: Static<typeof ListRunsAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const limit = args.limit ?? 20;
  // Keyset pagination short-circuits offset whenever a cursor is supplied.
  const hasCursor = args.before_id != null && args.before_created_at != null;
  const offset = hasCursor ? 0 : (args.offset ?? 0);

  // Shared WHERE fragment so the count and page queries can't drift apart.
  let where = sql`r.organization_id = ${ctx.organizationId}`;
  if (args.run_types && args.run_types.length > 0) {
    // fetch_types:false means JS arrays aren't auto-serialized — use the
    // PG array-literal helpers (see db/client.ts).
    where = sql`${where} AND r.run_type = ANY(${pgTextArray(args.run_types)}::text[])`;
  }
  // connection scope: scalar connection_id (REST/SDK), an explicit id list, or
  // every connection pinned to a device.
  if (args.connection_id != null) {
    where = sql`${where} AND r.connection_id = ${args.connection_id}`;
  }
  if (args.connection_ids && args.connection_ids.length > 0) {
    where = sql`${where} AND r.connection_id = ANY(${pgBigintArray(args.connection_ids)}::bigint[])`;
  }
  if (args.feed_ids && args.feed_ids.length > 0) {
    where = sql`${where} AND r.feed_id = ANY(${pgBigintArray(args.feed_ids)}::bigint[])`;
  }
  if (args.device_worker_id) {
    where = sql`${where} AND r.connection_id IN (
      SELECT id FROM connections
      WHERE device_worker_id = ${args.device_worker_id}
        AND organization_id = ${ctx.organizationId}
        AND deleted_at IS NULL
    )`;
  }
  if (args.operation_key) {
    where = sql`${where} AND r.action_key = ${args.operation_key}`;
  }
  if (args.status) {
    where = sql`${where} AND r.status = ${args.status}`;
  }
  if (args.approval_status) {
    where = sql`${where} AND r.approval_status = ${args.approval_status}`;
  }
  if (args.watcher_ids && args.watcher_ids.length > 0) {
    where = sql`${where} AND r.watcher_id = ANY(${pgBigintArray(args.watcher_ids)}::bigint[])`;
  }

  const countQuery = sql`SELECT COUNT(*)::int AS total FROM runs r WHERE ${where}`;

  let pageWhere = where;
  if (hasCursor) {
    pageWhere = sql`${pageWhere} AND (r.created_at, r.id) < (${args.before_created_at}::timestamptz, ${args.before_id})`;
  }
  const query = sql`
    SELECT r.id, r.run_type, r.watcher_id, r.connection_id, r.feed_id, r.connector_key, r.connector_version,
           r.action_key AS operation_key, r.action_input AS input, r.action_output AS output,
           r.approval_status, r.status, r.error_message, r.items_collected, r.checkpoint,
           r.created_at, r.completed_at,
           f.feed_key, f.display_name AS feed_display_name,
           c.display_name AS connection_display_name, c.device_worker_id
    FROM runs r
    LEFT JOIN feeds f ON f.id = r.feed_id
    LEFT JOIN connections c ON c.id = r.connection_id
    WHERE ${pageWhere}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [countResult, rows] = await Promise.all([countQuery, query]);

  return {
    action: 'list_runs',
    runs: rows,
    total: Number(countResult[0]?.total ?? 0),
    limit,
    offset,
    has_more: rows.length === limit,
  };
}

async function handleGetRun(
  args: Static<typeof GetRunAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const rows = await sql`
    SELECT r.id, r.connection_id, r.connector_key,
           r.action_key AS operation_key, r.action_input AS input, r.action_output AS output,
           r.approval_status, r.status, r.error_message,
           r.created_at, r.completed_at
    FROM runs r
    WHERE r.id = ${args.run_id}
      AND r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'action'
    LIMIT 1
  `;
  if (rows.length === 0) return { error: 'Run not found' };
  return { action: 'get_run', run: rows[0] };
}

export async function supersedeActionEvent(
  runId: number,
  organizationId: string,
  status: string,
  title: string,
  content: string,
  extraMetadata: Record<string, unknown> = {}
): Promise<number | undefined> {
  const sql = getDb();
  const originalEvent = await sql`
    SELECT id, entity_ids, connection_id, connector_key, metadata, author_name, interaction_input_schema, interaction_input
    FROM current_event_records
    WHERE run_id = ${runId}
      AND organization_id = ${organizationId}
      AND semantic_type = 'operation'
      AND interaction_type = 'approval'
    LIMIT 1
  `;
  if (originalEvent.length === 0) return undefined;

  const orig = originalEvent[0] as any;
  const nextEvent = await insertEvent({
    entityIds: Array.isArray(orig.entity_ids) ? orig.entity_ids.map(Number) : [],
    organizationId,
    originId: `run_${runId}_${status}_${Date.now()}`,
    title,
    content,
    semanticType: 'operation',
    connectorKey: orig.connector_key,
    connectionId: orig.connection_id,
    runId,
    interactionType: 'approval',
    interactionStatus:
      status === 'confirmed'
        ? 'approved'
        : status === 'rejected'
          ? 'rejected'
          : status === 'completed'
            ? 'completed'
            : status === 'failed'
              ? 'failed'
              : 'pending',
    interactionInputSchema:
      (orig.interaction_input_schema as Record<string, unknown> | null) ?? null,
    interactionInput: (orig.interaction_input as Record<string, unknown> | null) ?? null,
    interactionOutput:
      ((extraMetadata.output ?? extraMetadata.action_output) as
        | Record<string, unknown>
        | undefined) ?? null,
    interactionError: (extraMetadata.error_message as string | undefined) ?? null,
    supersedesEventId: Number(orig.id),
    metadata: {
      ...(orig.metadata ?? {}),
      status,
      ...(extraMetadata.output ? { action_output: extraMetadata.output } : {}),
      ...(extraMetadata.error_message ? { error_message: extraMetadata.error_message } : {}),
      ...extraMetadata,
    },
    authorName: orig.author_name ?? null,
  });

  return Number(nextEvent.id);
}

/**
 * Claim a pending builder-gate run (manage_agents create/update/delete) for the
 * given action. Returns the claimed run row (with the held proposal +
 * requester) or null when this run_id isn't a pending manage_agents run — in
 * which case the caller falls through to the connector-operation path.
 */
async function claimManageAgentsRun(
  runId: number,
  organizationId: string,
  decision: 'approved' | 'rejected',
  rejectReason?: string
): Promise<
  | { proposal: ManageAgentsProposal; requesterUserId: string | null }
  | null
> {
  const sql = getDb();
  const rows =
    decision === 'approved'
      ? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running'
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ${MANAGE_AGENTS_ACTION_KEY}
          RETURNING action_input, created_by_user_id
        `
      : await sql`
          UPDATE runs
          SET approval_status = 'rejected', status = 'cancelled',
              error_message = ${rejectReason ?? 'Rejected by user'}, completed_at = NOW()
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ${MANAGE_AGENTS_ACTION_KEY}
          RETURNING action_input, created_by_user_id
        `;
  if (rows.length === 0) return null;
  const row = rows[0] as {
    action_input: ManageAgentsProposal | null;
    created_by_user_id: string | null;
  };
  if (!row.action_input) return null;
  return { proposal: row.action_input, requesterUserId: row.created_by_user_id };
}

/**
 * Approve + apply a builder-gate manage_agents run. Returns a result when the
 * run was a pending manage_agents run; null to fall through to the
 * connector-operation approval path.
 */
async function tryApproveManageAgentsRun(
  args: Static<typeof ApproveAction>,
  ctx: ToolContext,
  env: Env
): Promise<ManageOperationsResult | null> {
  const claimed = await claimManageAgentsRun(
    args.run_id,
    ctx.organizationId,
    'approved'
  );
  if (!claimed) return null;

  const { proposal, requesterUserId } = claimed;
  await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'confirmed',
    `manage_agents.${proposal.action} — executing`,
    `Builder action confirmed: ${proposal.action} ${proposal.agent_id}`,
    {}
  );

  try {
    const output = await applyManageAgentsProposal(
      proposal,
      ctx,
      env,
      requesterUserId
    );
    await getDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${getDb().json(output as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    const eventId = await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'completed',
      `manage_agents.${proposal.action} — completed`,
      `Builder action completed: ${proposal.action} ${proposal.agent_id}`,
      { output: output as unknown as Record<string, unknown> }
    );
    return {
      action: 'approve',
      approved: true,
      run_id: args.run_id,
      event_id: eventId,
      message: `Agent ${proposal.action} approved and applied.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await getDb()`
      UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    const eventId = await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'failed',
      `manage_agents.${proposal.action} — failed`,
      `Builder action failed: ${proposal.action} ${proposal.agent_id} — ${errorMessage}`,
      { error_message: errorMessage }
    );
    return {
      action: 'approve',
      approved: true,
      run_id: args.run_id,
      event_id: eventId,
      message: `Agent ${proposal.action} approved but failed: ${errorMessage}`,
    };
  }
}

/**
 * Claim a pending entity_field_change run (a watcher field-change held for
 * approval). Mirrors claimManageAgentsRun. Returns the held proposal, or null when
 * this run isn't a pending field-change run.
 */
async function claimEntityFieldChangeRun(
  runId: number,
  organizationId: string,
  decision: 'approved' | 'rejected',
  rejectReason?: string
): Promise<{ proposal: EntityFieldChangeProposal } | null> {
  const sql = getDb();
  const rows =
    decision === 'approved'
      ? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running'
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ${ENTITY_FIELD_CHANGE_ACTION_KEY}
          RETURNING action_input
        `
      : await sql`
          UPDATE runs
          SET approval_status = 'rejected', status = 'cancelled',
              error_message = ${rejectReason ?? 'Rejected by user'}, completed_at = NOW()
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ${ENTITY_FIELD_CHANGE_ACTION_KEY}
          RETURNING action_input
        `;
  if (rows.length === 0) return null;
  const proposal = (rows[0] as { action_input: EntityFieldChangeProposal | null }).action_input;
  if (!proposal) return null;
  return { proposal };
}

/**
 * Approve + apply a pending entity_field_change run. Returns a result when the run
 * was a pending field-change run; null to fall through to other approval paths.
 */
async function tryApproveEntityFieldChangeRun(
  args: Static<typeof ApproveAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult | null> {
  const claimed = await claimEntityFieldChangeRun(args.run_id, ctx.organizationId, 'approved');
  if (!claimed) return null;
  const { proposal } = claimed;
  const fieldList = Object.keys(proposal.fields).join(', ');

  await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'confirmed',
    'entity_field_change — applying',
    `Field change confirmed: ${fieldList}`,
    {}
  );

  try {
    const result = await applyEntityFieldChangeProposal(proposal, ctx.userId);
    const staleFields = Object.keys(result.stale);
    // The human re-edited every proposed field after the watcher queued this — the
    // proposal is stale. Resolve the run without clobbering the newer human value.
    const allStale = Object.keys(result.applied).length === 0 && staleFields.length > 0;
    await getDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${getDb().json(result as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    const summary = allStale
      ? `Field change skipped — ${staleFields.join(', ')} already changed since proposed`
      : `Field change applied: ${fieldList}`;
    const eventId = await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'completed',
      allStale ? 'entity_field_change — skipped (stale)' : 'entity_field_change — completed',
      summary,
      { output: result as unknown as Record<string, unknown> }
    );
    return {
      action: 'approve',
      approved: true,
      run_id: args.run_id,
      event_id: eventId,
      message: allStale
        ? `Field change skipped: ${staleFields.join(', ')} was changed by a human after the watcher proposed it.`
        : `Field change approved and applied: ${fieldList}.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await getDb()`
      UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'failed',
      'entity_field_change — failed',
      `Field change failed: ${errorMessage}`,
      { error_message: errorMessage }
    );
    return { error: `Failed to apply field change: ${errorMessage}` };
  }
}

/**
 * Reject a pending entity_field_change run. Returns a result when the run was a
 * pending field-change run; null to fall through.
 */
async function tryRejectEntityFieldChangeRun(
  args: Static<typeof RejectAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult | null> {
  const reason = args.reason ?? 'Rejected by user';
  const claimed = await claimEntityFieldChangeRun(
    args.run_id,
    ctx.organizationId,
    'rejected',
    reason
  );
  if (!claimed) return null;
  const fieldList = Object.keys(claimed.proposal.fields).join(', ');
  const eventId = await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'rejected',
    'entity_field_change — rejected',
    `Field change rejected: ${fieldList}${args.reason ? ` — ${args.reason}` : ''}`,
    { reason }
  );
  return { action: 'reject', rejected: true, run_id: args.run_id, event_id: eventId };
}

async function handleApprove(
  args: Static<typeof ApproveAction>,
  ctx: ToolContext,
  env: Env
): Promise<ManageOperationsResult> {
  if (ctx.clientId) {
    return {
      error:
        'Operation approval requires a web session. Agents cannot approve their own operations.',
    };
  }

  const sql = getDb();

  // Builder-gate runs (manage_agents create/update/delete) reuse this same
  // durable approval path but have run_type='internal' + no connection. Apply
  // them via the manage_agents handlers rather than the connector-operation
  // executor.
  const builderResult = await tryApproveManageAgentsRun(args, ctx, env);
  if (builderResult) return builderResult;

  // Watcher field-change gate (run_type='internal', action_key='entity_field_change'):
  // approve applies the proposed value to the entity (now human-owned).
  const fieldChangeResult = await tryApproveEntityFieldChangeRun(args, ctx);
  if (fieldChangeResult) return fieldChangeResult;

  const runRows = await sql`
    UPDATE runs
    SET approval_status = 'approved',
        action_input = ${args.input ? sql.json(args.input) : sql`action_input`}
    WHERE id = ${args.run_id}
      AND organization_id = ${ctx.organizationId}
      AND approval_status = 'pending'
      AND run_type = 'action'
    RETURNING id, connection_id, action_key, action_input
  `;
  if (runRows.length === 0) {
    return { error: 'Run not found or not pending approval' };
  }

  const run = runRows[0] as {
    id: number;
    connection_id: number;
    action_key: string;
    action_input: Record<string, unknown> | null;
  };
  const resolved = await getOperationForConnection(
    ctx.organizationId,
    run.connection_id,
    run.action_key
  );
  if (!resolved) {
    return { error: `Operation '${run.action_key}' is no longer available for this connection.` };
  }

  const eventId = await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'confirmed',
    `${run.action_key} — executing`,
    `Operation confirmed: ${run.action_key} — waiting for execution`,
    args.input ? { approved_input: args.input } : {}
  );

  if (resolved.operation.backend === 'local_action') {
    return {
      action: 'approve',
      approved: true,
      run_id: args.run_id,
      event_id: eventId,
      message: 'Operation approved. The worker will execute it shortly.',
    };
  }

  await sql`UPDATE runs SET status = 'running' WHERE id = ${args.run_id}`;
  const result = await executeOperationInline(
    args.run_id,
    ctx.organizationId,
    resolved.connection,
    resolved.operation,
    (run.action_input ?? {}) as Record<string, unknown>,
    env
  );

  if (result.status === 'completed') {
    await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'completed',
      `${run.action_key} — completed`,
      `Operation completed: ${run.action_key}`,
      { output: result.output }
    );
    return {
      action: 'approve',
      approved: true,
      run_id: args.run_id,
      event_id: eventId,
      message: 'Operation approved and executed.',
    };
  }

  await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'failed',
    `${run.action_key} — failed`,
    `Operation failed: ${run.action_key}${result.error_message ? ` — ${result.error_message}` : ''}`,
    { error_message: result.error_message }
  );
  return {
    action: 'approve',
    approved: true,
    run_id: args.run_id,
    event_id: eventId,
    message: `Operation approved but execution failed: ${result.error_message}`,
  };
}

async function handleReject(
  args: Static<typeof RejectAction>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  if (ctx.clientId) {
    return {
      error: 'Operation rejection requires a web session. Agents cannot reject operations.',
    };
  }

  const sql = getDb();
  const reason = args.reason ?? 'Rejected by user';

  // Builder-gate run? Cancel it without touching the agents table.
  const claimedBuilder = await claimManageAgentsRun(
    args.run_id,
    ctx.organizationId,
    'rejected',
    reason
  );
  if (claimedBuilder) {
    const eventId = await supersedeActionEvent(
      args.run_id,
      ctx.organizationId,
      'rejected',
      `manage_agents.${claimedBuilder.proposal.action} — rejected`,
      `Builder action rejected: ${claimedBuilder.proposal.action} ${claimedBuilder.proposal.agent_id}${args.reason ? ` — ${args.reason}` : ''}`,
      { reason }
    );
    return { action: 'reject', rejected: true, run_id: args.run_id, event_id: eventId };
  }

  // Watcher field-change gate? Cancel it; the entity keeps its human-owned value.
  const fieldChangeReject = await tryRejectEntityFieldChangeRun(args, ctx);
  if (fieldChangeReject) return fieldChangeReject;

  const updated = await sql`
    UPDATE runs
    SET approval_status = 'rejected', status = 'cancelled', error_message = ${reason}, completed_at = NOW()
    WHERE id = ${args.run_id}
      AND organization_id = ${ctx.organizationId}
      AND approval_status = 'pending'
      AND run_type = 'action'
    RETURNING id, action_key
  `;
  if (updated.length === 0) {
    return { error: 'Run not found or not pending approval' };
  }

  const operationKey = (updated[0] as any).action_key;
  const eventId = await supersedeActionEvent(
    args.run_id,
    ctx.organizationId,
    'rejected',
    `${operationKey} — rejected`,
    `Operation rejected: ${operationKey}${args.reason ? ` — ${args.reason}` : ''}`,
    { reason }
  );

  return { action: 'reject', rejected: true, run_id: args.run_id, event_id: eventId };
}

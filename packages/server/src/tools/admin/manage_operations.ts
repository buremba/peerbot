/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import { callTool as callProxyTool } from '../../mcp-proxy/client';
import { resolveCredentialsByConnectionId } from '../../mcp-proxy/credential-resolver';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { getOperationForConnection, listOperations } from '../../operations/catalog';
import type { AvailableOperation, OperationDescriptor } from '../../operations/types';
import { resolveConnectorCode } from '../../utils/ensure-connector-installed';
import { resolveExecutionAuth } from '../../utils/execution-context';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { createConnectorOperationRun } from '../../utils/queue-helpers';
import { buildEventPermalink, getOrganizationSlug, getPublicWebUrl } from '../../utils/url-builder';
import { trackWatcherReaction } from '../../utils/watcher-reactions';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import { PaginationFields } from './schemas/common-fields';

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
  operation_key: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  approval_status: Type.Optional(Type.String()),
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

export const ManageOperationsSchema = Type.Union([
  ListAvailableAction,
  ExecuteAction,
  ListRunsAction,
  GetRunAction,
  ApproveAction,
  RejectAction,
]);

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
  | { action: 'list_runs'; runs: any[]; total: number; limit: number; offset: number }
  | { action: 'get_run'; run: any }
  | { action: 'approve'; approved: true; run_id: number; event_id?: number; message: string }
  | { action: 'reject'; rejected: true; run_id: number; event_id?: number };

type OperationsArgs = Static<typeof ManageOperationsSchema>;

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

export async function manageOperations(
  args: OperationsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  return routeAction<ManageOperationsResult>('manage_operations', args.action, ctx, {
    list_available: () =>
      handleListAvailable(args as Extract<OperationsArgs, { action: 'list_available' }>, ctx),
    execute: () => handleExecute(args as Extract<OperationsArgs, { action: 'execute' }>, env, ctx),
    list_runs: () => handleListRuns(args as Extract<OperationsArgs, { action: 'list_runs' }>, ctx),
    get_run: () => handleGetRun(args as Extract<OperationsArgs, { action: 'get_run' }>, ctx),
    approve: () => handleApprove(args as Extract<OperationsArgs, { action: 'approve' }>, env, ctx),
    reject: () => handleReject(args as Extract<OperationsArgs, { action: 'reject' }>, ctx),
  });
}

async function executeLocalActionInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>,
  env: Env
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMsg} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'failed', error_message: errorMsg };
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
    const { executeCompiledConnector, getActionOutput } = await import(
      '../../../../connector-worker/src/executor/runtime'
    );
    const result = await executeCompiledConnector({
      mode: 'action',
      compiledCode,
      actionKey:
        operation.backend_config.backend === 'local_action'
          ? operation.backend_config.actionKey
          : operation.operation_key,
      actionInput,
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')),
      connectionCredentials,
      sessionState,
      credentials,
      apiType: 'api',
    });

    const actionOutput = getActionOutput(result);
    await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(actionOutput)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'completed', output: actionOutput };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'failed', error_message: errorMessage };
  }
}

async function executeMcpToolInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>
): Promise<InlineExecutionResult> {
  const sql = getDb();
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
    await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorText} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'failed', error_message: errorText };
  }

  const output = { content: result.content } as Record<string, unknown>;
  await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
  return { status: 'completed', output };
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage} WHERE id = ${runId} AND organization_id = ${organizationId}`;
    return { status: 'failed', error_message: errorMessage };
  }
}

async function executeOperationInline(
  runId: number,
  organizationId: string,
  connection: ConnectionRow,
  operation: OperationDescriptor,
  actionInput: Record<string, unknown>,
  env: Env
): Promise<InlineExecutionResult> {
  if (operation.backend === 'local_action') {
    return executeLocalActionInline(runId, organizationId, connection, operation, actionInput, env);
  }
  if (operation.backend === 'mcp_tool') {
    return executeMcpToolInline(runId, organizationId, connection, operation, actionInput);
  }
  return executeHttpOperationInline(runId, organizationId, connection, operation, actionInput);
}

async function handleListAvailable(
  args: Extract<OperationsArgs, { action: 'list_available' }>,
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

async function handleExecute(
  args: Extract<OperationsArgs, { action: 'execute' }>,
  env: Env,
  ctx: ToolContext
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
  const connConfig = (connection.config ?? {}) as Record<string, unknown>;
  const autoApproveOperations = connConfig.auto_approve_actions;
  const autoApproveList = Array.isArray(autoApproveOperations)
    ? autoApproveOperations.filter((value): value is string => typeof value === 'string')
    : [];
  const requireApprovalOverrides = connConfig.require_approval_actions;
  const requireApprovalList = Array.isArray(requireApprovalOverrides)
    ? requireApprovalOverrides.filter((value): value is string => typeof value === 'string')
    : [];
  const shouldQueue =
    (operation.requires_approval || requireApprovalList.includes(operation.operation_key)) &&
    !autoApproveList.includes(operation.operation_key);

  const runId = await createConnectorOperationRun({
    organizationId: ctx.organizationId,
    connectionId: connection.id,
    connectorKey: connection.connector_key,
    operationKey: operation.operation_key,
    operationInput: input,
    approvalMode: shouldQueue ? 'queued' : 'inline',
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
    const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
    const orgSlug = await getOrganizationSlug(ctx.organizationId);
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

  const result = await executeOperationInline(
    runId,
    ctx.organizationId,
    connection,
    operation,
    input,
    env
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
  args: Extract<OperationsArgs, { action: 'list_runs' }>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;

  let countQuery = sql`
    SELECT COUNT(*)::int AS total
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'action'
  `;

  let query = sql`
    SELECT r.id, r.connection_id, r.connector_key,
           r.action_key AS operation_key, r.action_input AS input, r.action_output AS output,
           r.approval_status, r.status, r.error_message,
           r.created_at, r.completed_at
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'action'
  `;

  if (args.connection_id) {
    countQuery = sql`${countQuery} AND r.connection_id = ${args.connection_id}`;
    query = sql`${query} AND r.connection_id = ${args.connection_id}`;
  }
  if (args.operation_key) {
    countQuery = sql`${countQuery} AND r.action_key = ${args.operation_key}`;
    query = sql`${query} AND r.action_key = ${args.operation_key}`;
  }
  if (args.status) {
    countQuery = sql`${countQuery} AND r.status = ${args.status}`;
    query = sql`${query} AND r.status = ${args.status}`;
  }
  if (args.approval_status) {
    countQuery = sql`${countQuery} AND r.approval_status = ${args.approval_status}`;
    query = sql`${query} AND r.approval_status = ${args.approval_status}`;
  }

  query = sql`${query} ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const [countResult, rows] = await Promise.all([countQuery, query]);

  return {
    action: 'list_runs',
    runs: rows,
    total: Number(countResult[0]?.total ?? 0),
    limit,
    offset,
  };
}

async function handleGetRun(
  args: Extract<OperationsArgs, { action: 'get_run' }>,
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

async function handleApprove(
  args: Extract<OperationsArgs, { action: 'approve' }>,
  env: Env,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  if (ctx.clientId) {
    return {
      error:
        'Operation approval requires a web session. Agents cannot approve their own operations.',
    };
  }

  const sql = getDb();
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
  args: Extract<OperationsArgs, { action: 'reject' }>,
  ctx: ToolContext
): Promise<ManageOperationsResult> {
  if (ctx.clientId) {
    return {
      error: 'Operation rejection requires a web session. Agents cannot reject operations.',
    };
  }

  const sql = getDb();
  const reason = args.reason ?? 'Rejected by user';
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

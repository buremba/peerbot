/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { getErrorMessage } from "@lobu/core";
import {
	ApproveAction,
	ApproveBatchAction,
	ExecuteAction,
	GetRunAction,
	ListAvailableAction,
	ListRunsAction,
	type ManageOperationsResult,
	ManageOperationsResultSchema,
	ManageOperationsSchema,
	RejectAction,
	RejectBatchAction,
} from "@lobu/core/contracts/tools/manage-operations";
import type { Static } from "@sinclair/typebox";
import {
	getDb,
	parsePgNumberArray,
	pgBigintArray,
	pgTextArray,
} from "../../db/client";
import type { Env } from "../../index";
import { callTool as callProxyTool } from "../../mcp-proxy/client";
import { resolveCredentialsByConnectionId } from "../../mcp-proxy/credential-resolver";
import {
	classifyMutationPrincipal,
	mutationPrincipalId,
	resolveWritePolicyDecision,
} from "../../authz/entity-policy";
import { notifyActionApprovalNeeded } from "../../notifications/triggers";
import { resolveActionMode } from "../../operations/action-modes";
import {
	getOperationForConnection,
	listOperations,
} from "../../operations/connector-operations";
import { validateOperationInput } from "../../operations/input-validation";
import type { OperationDescriptor } from "../../operations/types";
import { createConnectorOperationRun } from "../../runs/queue-service";
import { resolveConnectorCode } from "../../utils/ensure-connector-installed";
import { resolveExecutionAuth } from "../../utils/execution-context";
import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import { buildResourcePermalink } from "../../utils/url-builder";
import { trackWatcherReaction } from "../../utils/watcher-reactions";
import { dispatchChromeActionToExtension } from "../../worker-api/dispatch-chrome-action";
import { isAdminOrOwnerRole } from "../access-control";
import type { ToolContext } from "../registry";
import { getOrgUrlContext } from "../view-urls";
import { action, defineActionTool } from "./action-tool";
import {
	applyEntityChangeProposal,
	ENTITY_CHANGE_ACTION_KEYS,
	type EntityChangeProposal,
} from "./entity-field-approval";
import {
	applyManageAgentsProposal,
	MANAGE_AGENTS_ACTION_KEY,
	type ManageAgentsProposal,
} from "./manage_agents";

type InlineExecutionResult =
	| {
			status: "completed";
			output: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| { status: "failed"; error_message: string };

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
  approve_batch: action(ApproveBatchAction, handleApproveBatch),
  reject_batch: action(RejectBatchAction, handleRejectBatch),
});

export { ManageOperationsResultSchema, ManageOperationsSchema };
export const manageOperations = manageOperationsTool.run;

// Update the run to failed status and return the error result in one call.
async function failRunInline(
	runId: number,
	organizationId: string,
	errorMsg: string,
): Promise<InlineExecutionResult> {
	const sql = getDb();
	await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMsg} WHERE id = ${runId} AND organization_id = ${organizationId}`;
	return { status: "failed", error_message: errorMsg };
}

// Update the run to completed status and return the output in one call.
async function completeRunInline(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
): Promise<InlineExecutionResult> {
	const sql = getDb();
	await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
	return { status: "completed", output };
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
	connectionConfig: Record<string, unknown> | null | undefined,
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
	abortSignal?: AbortSignal,
): Promise<InlineExecutionResult> {
	const sql = getDb();

	const runRows =
		await sql`SELECT connector_version FROM runs WHERE id = ${runId} AND organization_id = ${organizationId} AND run_type = 'action' LIMIT 1`;
	const connectorVersion = (
		runRows[0] as { connector_version: string | null } | undefined
	)?.connector_version;

	const compiledRows = connectorVersion
		? await sql`SELECT compiled_code FROM connector_versions WHERE connector_key = ${connection.connector_key} AND version = ${connectorVersion} LIMIT 1`
		: await sql`SELECT compiled_code FROM connector_versions WHERE connector_key = ${connection.connector_key} ORDER BY created_at DESC LIMIT 1`;

	let compiledCode: string;
	try {
		const rawCode =
			(compiledRows[0] as { compiled_code: string | null } | undefined)
				?.compiled_code ?? null;
		compiledCode = await resolveConnectorCode(
			connection.connector_key,
			rawCode,
		);
	} catch (err) {
		return failRunInline(runId, organizationId, getErrorMessage(err));
	}

	const { credentials, connectionCredentials, sessionState } =
		await resolveExecutionAuth({
			organizationId,
			connectionId: connection.id,
			authProfileId: Number(connection.auth_profile_id) || null,
			appAuthProfileId: Number(connection.app_auth_profile_id) || null,
			credentialDb: getDb(),
			logContext: { run_id: runId },
			logMessage: "Failed to resolve action credentials",
		});

	try {
		const { executeCompiledConnector } = await import(
			"@lobu/connector-worker/executor/runtime"
		);
		const envStrings = Object.fromEntries(
			Object.entries(env).filter(([, value]) => typeof value === "string"),
		);
		const result = await executeCompiledConnector({
			compiledCode,
			job: {
				mode: "action",
				actionKey:
					operation.backend_config.backend === "local_action"
						? operation.backend_config.actionKey
						: operation.operation_key,
				actionInput,
				// Merge the connection's own config (e.g. a Deliveroo connection's
				// `restaurants_url`) into the action config, the way a sync merges its
				// feed config. See buildActionConfig for the precedence.
				config: buildActionConfig(
					envStrings,
					connectionCredentials,
					connection.config as Record<string, unknown> | null,
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
						// Browser affinity: data connection pin to a chrome-extension
						// selects which Owletto browser receives scrapes.
						parentConnectionId: connection.id,
						abortSignal,
					});

					if (dispatchResult.status !== "completed") {
						throw new Error(
							dispatchResult.error_message ??
								`chrome action '${actionKey}' ${dispatchResult.status}`,
						);
					}
					return dispatchResult.output ?? {};
				},
			},
		});

		if (result.mode !== "action") {
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
	actionInput: Record<string, unknown>,
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
	input: Record<string, unknown>,
): URL {
	const pathValues =
		input.path && typeof input.path === "object"
			? (input.path as Record<string, unknown>)
			: {};
	const queryValues =
		input.query && typeof input.query === "object"
			? (input.query as Record<string, unknown>)
			: {};
	let path = pathTemplate;
	for (const [key, value] of Object.entries(pathValues)) {
		path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
	}

	const url = new URL(
		path,
		serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
	);
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
	actionInput: Record<string, unknown>,
): Promise<InlineExecutionResult> {
	const sql = getDb();
	if (operation.backend_config.backend !== "http_operation") {
		return {
			status: "failed",
			error_message: "Invalid HTTP operation backend config",
		};
	}

	const credentials = await resolveCredentialsByConnectionId(
		connection.id,
		organizationId,
	);
	if (!credentials) {
		return {
			status: "failed",
			error_message: `No active OAuth credentials found for '${connection.connector_key}'.`,
		};
	}

	const headersInput =
		actionInput.headers && typeof actionInput.headers === "object"
			? (actionInput.headers as Record<string, unknown>)
			: {};
	const headers = new Headers();
	for (const [key, value] of Object.entries(headersInput)) {
		if (
			/^(authorization|host)$/i.test(key) ||
			value === undefined ||
			value === null
		)
			continue;
		headers.set(key, String(value));
	}
	headers.set(
		"Authorization",
		`${credentials.tokenType} ${credentials.accessToken}`,
	);

	const body = actionInput.body;
	let requestBody: string | undefined;
	if (body !== undefined) {
		requestBody = typeof body === "string" ? body : JSON.stringify(body);
		if (
			!headers.has("content-type") &&
			typeof body === "object" &&
			body !== null
		) {
			headers.set("content-type", "application/json");
		}
	}

	const url = buildResolvedUrl(
		operation.backend_config.serverUrl,
		operation.backend_config.pathTemplate,
		actionInput,
	);

	try {
		const response = await fetch(url, {
			method: operation.backend_config.method,
			headers,
			body: ["GET", "HEAD"].includes(operation.backend_config.method)
				? undefined
				: requestBody,
			redirect: "manual",
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
				Object.entries(headerMetadata).filter(([key]) =>
					key.startsWith("x-ratelimit"),
				),
			);
			if (Object.keys(rateLimits).length > 0) metadata.rate_limits = rateLimits;
			if (headerMetadata.link)
				metadata.pagination = { link: headerMetadata.link };
		}

		if (!response.ok) {
			const errorText =
				typeof parsedBody === "string" ? parsedBody : `HTTP ${response.status}`;
			await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), action_output = ${sql.json(output)}, error_message = ${errorText} WHERE id = ${runId} AND organization_id = ${organizationId}`;
			return { status: "failed", error_message: errorText };
		}

		await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
		return { status: "completed", output, metadata };
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
	abortSignal?: AbortSignal,
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
	ctx: ToolContext,
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
	status: "completed" | "failed" | "timeout";
	// `action_output` is arbitrary connector/device JSON — object, array, or
	// scalar — so the completed output is `unknown`, not an object.
	output?: unknown;
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
			action_output: unknown;
			error_message: string | null;
			claimed_at: Date | string | null;
		}>;
		const row = rows[0];
		if (!row) {
			return {
				status: "failed",
				error_message: `Run ${runId} disappeared from runs table while waiting.`,
			};
		}
		if (row.status === "completed") {
			return {
				status: "completed",
				output: row.action_output ?? {},
			};
		}
		if (row.status === "failed" || row.status === "timeout") {
			return {
				status: row.status as "failed" | "timeout",
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
		if (final?.status === "completed") {
			return {
				status: "completed",
				output: (final.action_output ?? {}) as Record<string, unknown>,
			};
		}
		if (final?.status === "failed") {
			return {
				status: "failed",
				error_message: final.error_message ?? `Run ${runId} failed`,
			};
		}
		// Shouldn't reach here, but fall through to timeout.
	}

	return {
		status: "timeout",
		error_message:
			claimedAtMs != null
				? `Run ${runId} claimed but the device worker didn't finish within ${POST_CLAIM_BUDGET_MS}ms.`
				: `Run ${runId} was never claimed within ${QUEUE_BUDGET_MS}ms — the chrome-extension / device worker may be offline.`,
	};
}

async function handleExecute(
	args: Static<typeof ExecuteAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	const resolved = await getOperationForConnection(
		ctx.organizationId,
		args.connection_id,
		args.operation_key,
	);
	if (!resolved) {
		return {
			error: `Invalid operation_key '${args.operation_key}' for this connection.`,
		};
	}

	const { connection, operation } = resolved;
	if (connection.status !== "active") {
		return { error: `Connection is ${connection.status}, must be active` };
	}

	const input = args.input ?? {};
	const validationError = validateOperationInput(operation, input);
	if (validationError) {
		return {
			error: `Invalid input for operation '${operation.operation_key}': ${validationError}`,
		};
	}

	const mode = resolveActionMode(operation, connection.config);
	if (mode === "disabled") {
		return {
			error: `Operation '${operation.operation_key}' is disabled on this connection.`,
		};
	}

	// Org-level connector-action policy, from the SAME write-gate the entity and
	// agent_config classes use. It folds with the per-connection action_modes by
	// restrictive-wins: a `deny` blocks outright; an `approval` upgrades a
	// connection that would auto-run to queued. A human applies immediately (the
	// policy governs non-human principals); with no policy row, the class default
	// is auto, so the connection mode alone decides — today's behavior is intact.
	const principalKind = classifyMutationPrincipal({
		userId: ctx.userId,
		agentId: ctx.agentId,
		watcherSource: args.watcher_source ?? null,
	});
	const principalId = mutationPrincipalId({
		agentId: ctx.agentId,
		watcherId: args.watcher_source?.watcher_id ?? null,
	});
	const policyDecision = await resolveWritePolicyDecision({
		organizationId: ctx.organizationId,
		resourceClass: "connector_action",
		principalKind,
		principalId,
		action: "create",
	});
	if (policyDecision === "deny") {
		return {
			error: `Policy denies '${operation.operation_key}' for this principal.`,
		};
	}
	const shouldQueue = mode === "approval" || policyDecision === "require_approval";

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

	const approvalMode: "inline" | "queued" | "device" = shouldQueue
		? "queued"
		: isDeviceBound
			? "device"
			: "inline";

	const runId = await createConnectorOperationRun({
		organizationId: ctx.organizationId,
		connectionId: connection.id,
		connectorKey: connection.connector_key,
		operationKey: operation.operation_key,
		operationInput: input,
		approvalMode,
		requireCompiledCode: operation.backend === "local_action",
		// Persist the TRUSTED principal so a queued run's policy is re-evaluated
		// at approve time against who queued it, not who approves it (sol #5).
		policyPrincipalKind: principalKind,
		policyPrincipalId: principalId,
	});

	if (args.watcher_source) {
		await trackWatcherReaction({
			organizationId: ctx.organizationId,
			watcherId: args.watcher_source.watcher_id,
			windowId: args.watcher_source.window_id,
			reactionType: "action_executed",
			toolName: "manage_operations",
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
			(feedRows[0] as { entity_ids: string | number[] } | undefined)
				?.entity_ids ?? null;
		const entityIdsLiteral = rawEntityIds
			? typeof rawEntityIds === "string"
				? rawEntityIds
				: `{${(rawEntityIds as number[]).join(",")}}`
			: null;
		const event = await insertEvent({
			entityIds:
				entityIdsLiteral && typeof entityIdsLiteral === "string"
					? entityIdsLiteral
							.replace(/[{}]/g, "")
							.split(",")
							.filter(Boolean)
							.map(Number)
					: [],
			organizationId: ctx.organizationId,
			originId: `run_${runId}_pending`,
			title: `${operation.name} — pending approval`,
			content: `Agent requested operation: ${operation.name}`,
			semanticType: "operation",
			connectorKey: connection.connector_key,
			connectionId: args.connection_id,
			runId,
			interactionType: "approval",
			interactionStatus: "pending",
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
				status: "pending_approval",
				connection_name: connection.display_name ?? connection.connector_key,
				run_id: runId,
			},
			authorName: ctx.clientId ?? "agent",
		});
		const eventId = Number(event.id);
		const { ownerSlug: orgSlug, baseUrl } = await getOrgUrlContext(ctx);
		// Run-scoped, not event-scoped: the pending event is superseded on
		// approve→complete and drops out of the live view, but a run_ids permalink
		// reads the whole chain and stays valid across the lifecycle. (The read-side
		// content_ids resolver also covers already-minted event-scoped links.)
		const approvalUrl = buildResourcePermalink(
			orgSlug,
			{ kind: "run", runId },
			baseUrl,
		);

		notifyActionApprovalNeeded({
			orgId: ctx.organizationId,
			runId,
			actionKey: operation.operation_key,
			connectionName: connection.display_name ?? connection.connector_key,
			eventId,
			approvalUrl,
		}).catch((error) =>
			logger.error(error, "Failed to send operation approval notification"),
		);

		return {
			action: "execute",
			run_id: runId,
			event_id: eventId,
			approval_url: approvalUrl,
			status: "pending_approval",
			message: `Operation '${operation.name}' requires approval. Share the approval_url with the user to confirm.`,
		};
	}

	// Device-bound branch: the run is pending; a device worker (chrome
	// extension, mac bridge, ...) will claim it via /api/workers/poll and
	// post completion to /api/workers/complete-action. Poll runs.status
	// here until it flips to completed/failed/timeout, or we hit the
	// device-action timeout. Returns action_output on success.
	if (approvalMode === "device") {
		const result = await waitForDeviceActionRun(
			runId,
			ctx.organizationId,
			ctx.abortSignal,
		);
		if (result.status === "completed") {
			return {
				action: "execute",
				run_id: runId,
				status: "completed",
				output: result.output ?? {},
			};
		}
		if (result.status === "timeout") {
			return {
				action: "execute",
				run_id: runId,
				status: "timeout",
				error_message: result.error_message ?? "Device action run timed out.",
			};
		}
		return {
			action: "execute",
			run_id: runId,
			status: "failed",
			error_message: result.error_message ?? "Device action run failed.",
		};
	}

	const result = await executeOperationInline(
		runId,
		ctx.organizationId,
		connection,
		operation,
		input,
		env,
		ctx.abortSignal,
	);
	if (result.status === "completed") {
		return {
			action: "execute",
			run_id: runId,
			status: "completed",
			output: result.output,
			...(result.metadata ? { metadata: result.metadata } : {}),
		};
	}
	return {
		action: "execute",
		run_id: runId,
		status: "failed",
		error_message: result.error_message,
	};
}

async function handleListRuns(
	args: Static<typeof ListRunsAction>,
	ctx: ToolContext,
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
	ctx: ToolContext,
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

/**
 * The human who decided an approval. Threaded from the approve/reject handler
 * (a web session — `ctx.userId` is the acting user) into every event of the
 * post-decision chain (approved → completed/failed), so each state records who
 * authorized it. `null` for system-driven supersessions with no acting user
 * (e.g. a worker completing a device action it was told to run).
 */
export interface ApprovalReviewer {
  userId: string;
  /** Display name resolved at decision time; falls back to userId when unknown. */
  name: string | null;
}

export async function supersedeActionEvent(
	runId: number,
	organizationId: string,
	status: string,
	title: string,
	content: string,
	extraMetadata: Record<string, unknown> = {},
	reviewer: ApprovalReviewer | null = null,
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
	// Carry the reviewer forward. A decision (approve/reject) supplies one; the
	// later system transitions (completed/failed) don't re-supply it, so inherit
	// the reviewer already stamped on the prior state — the person who authorized
	// the run owns its whole outcome in the audit trail.
	const priorMetadata = (orig.metadata ?? {}) as Record<string, unknown>;
	const reviewedById =
		reviewer?.userId ??
		(priorMetadata.reviewed_by_id as string | undefined) ??
		null;
	const reviewedByName =
		reviewer?.name ??
		(priorMetadata.reviewed_by_name as string | undefined) ??
		null;

	const nextEvent = await insertEvent({
		entityIds: Array.isArray(orig.entity_ids)
			? orig.entity_ids.map(Number)
			: [],
		organizationId,
		originId: `run_${runId}_${status}_${Date.now()}`,
		title,
		content,
		semanticType: "operation",
		connectorKey: orig.connector_key,
		connectionId: orig.connection_id,
		runId,
		interactionType: "approval",
		interactionStatus:
			status === "confirmed"
				? "approved"
				: status === "rejected"
					? "rejected"
					: status === "completed"
						? "completed"
						: status === "failed"
							? "failed"
							: "pending",
		interactionInputSchema:
			(orig.interaction_input_schema as Record<string, unknown> | null) ?? null,
		interactionInput:
			(orig.interaction_input as Record<string, unknown> | null) ?? null,
		interactionOutput:
			((extraMetadata.output ?? extraMetadata.action_output) as
				| Record<string, unknown>
				| undefined) ?? null,
		interactionError:
			(extraMetadata.error_message as string | undefined) ?? null,
		supersedesEventId: Number(orig.id),
		// The durable identity (FK → user); set on the first decision event and
		// preserved down the chain.
		createdBy: reviewedById,
		metadata: {
			...priorMetadata,
			status,
			...(reviewedById ? { reviewed_by_id: reviewedById } : {}),
			...(reviewedByName ? { reviewed_by_name: reviewedByName } : {}),
			...(extraMetadata.output ? { action_output: extraMetadata.output } : {}),
			...(extraMetadata.error_message
				? { error_message: extraMetadata.error_message }
				: {}),
			...extraMetadata,
		},
		authorName: orig.author_name ?? null,
	});

	return Number(nextEvent.id);
}

/**
 * Resolve the acting user's display name for the approval audit trail. Approvals
 * are web-session only (`ctx.clientId` is rejected upstream), so `ctx.userId` is
 * always a real human here; we still guard on null for safety.
 */
async function resolveReviewer(ctx: ToolContext): Promise<ApprovalReviewer | null> {
  if (!ctx.userId) return null;
  const rows = await getDb()<{ name: string | null }>`
    SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1
  `;
  return { userId: ctx.userId, name: rows[0]?.name ?? null };
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
	decision: "approved" | "rejected",
	rejectReason?: string,
): Promise<{
	proposal: ManageAgentsProposal;
	requesterUserId: string | null;
} | null> {
	const sql = getDb();
	const rows =
		decision === "approved"
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
	env: Env,
): Promise<ManageOperationsResult | null> {
	const claimed = await claimManageAgentsRun(
		args.run_id,
		ctx.organizationId,
		"approved",
	);
	if (!claimed) return null;

	const { proposal, requesterUserId } = claimed;
	const reviewer = await resolveReviewer(ctx);
	await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"confirmed",
		`manage_agents.${proposal.action} — executing`,
		`Builder action confirmed: ${proposal.action} ${proposal.agent_id}`,
		{},
		reviewer,
	);

	try {
		const output = await applyManageAgentsProposal(
			proposal,
			ctx,
			env,
			requesterUserId,
		);
		await getDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${getDb().json(output as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"completed",
			`manage_agents.${proposal.action} — completed`,
			`Builder action completed: ${proposal.action} ${proposal.agent_id}`,
			{ output: output as unknown as Record<string, unknown> },
			reviewer,
		);
		return {
			action: "approve",
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
			"failed",
			`manage_agents.${proposal.action} — failed`,
			`Builder action failed: ${proposal.action} ${proposal.agent_id} — ${errorMessage}`,
			{ error_message: errorMessage },
			reviewer,
		);
		return {
			action: "approve",
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
async function claimEntityChangeRun(
	runId: number,
	organizationId: string,
	decision: "approved" | "rejected",
	rejectReason?: string,
): Promise<{ proposal: EntityChangeProposal } | null> {
	const sql = getDb();
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows =
		decision === "approved"
			? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running'
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys}::text[])
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
            AND action_key = ANY(${actionKeys}::text[])
          RETURNING action_input
        `;
	if (rows.length === 0) return null;
	const proposal = (rows[0] as { action_input: EntityChangeProposal | null })
		.action_input;
	if (!proposal) return null;
	return { proposal };
}

function entityChangeOperation(
	proposal: EntityChangeProposal,
): "create" | "update" | "delete" {
	return proposal.operation ?? "update";
}

function describeEntityChange(proposal: EntityChangeProposal): string {
	const operation = entityChangeOperation(proposal);
	if (operation === "update") {
		return Object.keys(
			(proposal as Extract<EntityChangeProposal, { operation?: "update" }>)
				.fields,
		).join(", ");
	}
	if (operation === "delete") {
		const deleteProposal = proposal as Extract<
			EntityChangeProposal,
			{ operation: "delete" }
		>;
		return deleteProposal.current?.name ?? `entity ${deleteProposal.entity_id}`;
	}
	return (proposal as Extract<EntityChangeProposal, { operation: "create" }>)
		.entity_data.name;
}

/**
 * Approve + apply a pending entity_field_change run. Returns a result when the run
 * was a pending field-change run; null to fall through to other approval paths.
 */
/**
 * Non-admin authority: a member may decide a run ONLY when it is a pending
 * entity-change proposal that records them as the field owner
 * (action_input.owner_user_id, resolved at propose time from field_controls).
 * Checked BEFORE any claim so an unauthorized call can never flip run state.
 */
async function isPendingEntityRunOwner(
	runId: number,
	organizationId: string,
	userId: string | null,
): Promise<boolean> {
	if (!userId) return false;
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows = await getDb()`
    SELECT 1 FROM runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND run_type = 'internal'
      AND action_key = ANY(${actionKeys}::text[])
      AND approval_status = 'pending'
      AND action_input->>'owner_user_id' = ${userId}
    LIMIT 1
  `;
	return rows.length > 0;
}

/**
 * Approving/rejecting a run is a HUMAN decision — it must come from a verified
 * user session, never from any non-human context. This is the security floor
 * beneath {@link requireApprovalAuthority}'s role check.
 *
 * Rejecting `ctx.clientId` alone is not enough: an in-process watcher/system
 * context runs with `userId=null` and NO client id, so it would slip past a
 * client-id-only guard AND past {@link isSystemContext}'s role bypass — letting
 * an automation approve a run it queued (sol review #3). We therefore require a
 * positive human identity: `userId` present, and no agent identity on the
 * context. Returns an error result (surfaced to the caller) or null when the
 * context is a genuine human. One gate, called by every approve/reject entry.
 */
function requireHumanApprovalContext(
	ctx: ToolContext,
	verb: "approve" | "reject",
): { error: string } | null {
	if (ctx.agentId || ctx.clientId) {
		return {
			error: `Operation ${verb === "approve" ? "approval" : "rejection"} requires a human web session. Agents cannot ${verb} operations.`,
		};
	}
	if (!ctx.userId) {
		return {
			error: `Operation ${verb === "approve" ? "approval" : "rejection"} requires a signed-in user. This request has no verified human identity.`,
		};
	}
	return null;
}

/**
 * The admin-or-run-owner gate shared by approve/reject, layered ON TOP of
 * {@link requireHumanApprovalContext} (which every caller runs first, so a
 * verified human identity is already guaranteed here). The tool-access tier
 * admits write-tier members so a recorded field owner can decide their own
 * run; everyone else non-admin gets the same admin-access denial the action
 * tier used to throw. No system-context bypass — a run decision is always human.
 */
async function requireApprovalAuthority(
	action: "approve" | "reject",
	runId: number,
	ctx: ToolContext,
): Promise<void> {
	if (isAdminOrOwnerRole(ctx.memberRole)) return;
	if (await isPendingEntityRunOwner(runId, ctx.organizationId, ctx.userId)) {
		return;
	}
	throw new Error(
		`Action manage_operations.${action} requires admin or owner access. Ask an organization owner to grant elevated access.`,
	);
}

async function tryApproveEntityChangeRun(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult | null> {
	const claimed = await claimEntityChangeRun(
		args.run_id,
		ctx.organizationId,
		"approved",
	);
	if (!claimed) return null;
	const { proposal } = claimed;
	const operation = entityChangeOperation(proposal);
	const description = describeEntityChange(proposal);
	const reviewer = await resolveReviewer(ctx);

	await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"confirmed",
		operation === "update"
			? "entity_field_change — applying"
			: `entity_${operation} — applying`,
		operation === "update"
			? `Field change confirmed: ${description}`
			: `Entity ${operation} confirmed: ${description}`,
		{},
		reviewer,
	);

	try {
		const result = await applyEntityChangeProposal(proposal, ctx, env);
		const staleFields =
			operation === "update" &&
			result &&
			typeof result === "object" &&
			"stale" in result
				? Object.keys((result as { stale: Record<string, unknown> }).stale)
				: [];
		// The human re-edited every proposed field after the watcher queued this — the
		// proposal is stale. Resolve the run without clobbering the newer human value.
		const allStale =
			operation === "update" &&
			result &&
			typeof result === "object" &&
			"applied" in result &&
			Object.keys((result as { applied: Record<string, unknown> }).applied)
				.length === 0 &&
			staleFields.length > 0;
		await getDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${getDb().json(result as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
		const summary = allStale
			? `Field change skipped — ${staleFields.join(", ")} already changed since proposed`
			: operation === "update"
				? `Field change applied: ${description}`
				: `Entity ${operation} applied: ${description}`;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"completed",
			allStale
				? "entity_field_change — skipped (stale)"
				: operation === "update"
					? "entity_field_change — completed"
					: `entity_${operation} — completed`,
			summary,
			{ output: result as unknown as Record<string, unknown> },
			reviewer,
		);
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: allStale
				? `Field change skipped: ${staleFields.join(", ")} was changed by a human after the watcher proposed it.`
				: operation === "update"
					? `Field change approved and applied: ${description}.`
					: `Entity ${operation} approved and applied: ${description}.`,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Apply failures here are often transient/situational (entity gained
		// children before a non-force delete, schema changed, etc.). Put the run
		// BACK to pending instead of burning the proposal on one errant click —
		// the reviewer can retry after fixing the blocker, or reject it.
		await getDb()`
      UPDATE runs SET approval_status = 'pending', status = 'pending', error_message = ${errorMessage}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
		await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"apply_failed",
			operation === "update"
				? "entity_field_change — apply failed, still pending"
				: `entity_${operation} — apply failed, still pending`,
			`Applying the approved change failed: ${errorMessage}. The approval is pending again — fix the blocker and approve once more, or reject it.`,
			{ error_message: errorMessage },
			reviewer,
		);
		return {
			error: `Failed to apply entity ${operation}: ${errorMessage}. The approval is back to pending — approve again after fixing the blocker, or reject it.`,
		};
	}
}

/**
 * Reject a pending entity_field_change run. Returns a result when the run was a
 * pending field-change run; null to fall through.
 */
async function tryRejectEntityChangeRun(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult | null> {
	const reason = args.reason ?? "Rejected by user";
	const claimed = await claimEntityChangeRun(
		args.run_id,
		ctx.organizationId,
		"rejected",
		reason,
	);
	if (!claimed) return null;
	const operation = entityChangeOperation(claimed.proposal);
	const description = describeEntityChange(claimed.proposal);
	const reviewer = await resolveReviewer(ctx);
	const eventId = await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"rejected",
		operation === "update"
			? "entity_field_change — rejected"
			: `entity_${operation} — rejected`,
		operation === "update"
			? `Field change rejected: ${description}${args.reason ? ` — ${args.reason}` : ""}`
			: `Entity ${operation} rejected: ${description}${args.reason ? ` — ${args.reason}` : ""}`,
		// reject_reason, NOT reason: metadata.reason is the PROPOSER's rationale
		// and must survive the supersede for the card's "Reasoning" panel.
		{ reject_reason: reason },
		reviewer,
	);
	return {
		action: "reject",
		rejected: true,
		run_id: args.run_id,
		event_id: eventId,
	};
}

async function handleApprove(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "approve");
	if (humanGate) return humanGate;
	await requireApprovalAuthority("approve", args.run_id, ctx);

	const sql = getDb();

	// Builder-gate runs (manage_agents create/update/delete) reuse this same
	// durable approval path but have run_type='internal' + no connection. Apply
	// them via the manage_agents handlers rather than the connector-operation
	// executor.
	const builderResult = await tryApproveManageAgentsRun(args, ctx, env);
	if (builderResult) return builderResult;

	// Watcher field-change gate (run_type='internal', action_key='entity_field_change'):
	// approve applies the proposed value to the entity (now human-owned).
	const fieldChangeResult = await tryApproveEntityChangeRun(args, ctx, env);
	if (fieldChangeResult) return fieldChangeResult;

	const pendingRows = await sql`
    SELECT id, connection_id, action_key, action_input,
           policy_principal_kind, policy_principal_id
    FROM runs
    WHERE id = ${args.run_id}
      AND organization_id = ${ctx.organizationId}
      AND approval_status = 'pending'
      AND run_type = 'action'
    LIMIT 1
  `;
	if (pendingRows.length === 0) {
		return { error: "Run not found or not pending approval" };
	}

	const pendingRun = pendingRows[0] as {
		id: number;
		connection_id: number;
		action_key: string;
		action_input: Record<string, unknown> | null;
		policy_principal_kind: string | null;
		policy_principal_id: string | null;
	};
	const resolved = await getOperationForConnection(
		ctx.organizationId,
		pendingRun.connection_id,
		pendingRun.action_key,
	);
	if (!resolved) {
		return {
			error: `Operation '${pendingRun.action_key}' is no longer available for this connection.`,
		};
	}

	// (sol #5) Re-evaluate the connector-action write-gate NOW, at approve time,
	// against the CURRENT connection mode + org policy — using the trusted
	// principal persisted when the run was queued (not the approver). A deny or
	// disabled installed after queueing but before this approval must cancel it,
	// not sail through on the stale queue-time check.
	const currentMode = resolveActionMode(
		resolved.operation,
		resolved.connection.config,
	);
	const recheckPrincipalKind =
		pendingRun.policy_principal_kind === "agent" ||
		pendingRun.policy_principal_kind === "watcher"
			? pendingRun.policy_principal_kind
			: "user";
	const recheckDecision =
		recheckPrincipalKind === "user"
			? "allow"
			: await resolveWritePolicyDecision({
					organizationId: ctx.organizationId,
					resourceClass: "connector_action",
					principalKind: recheckPrincipalKind,
					principalId: pendingRun.policy_principal_id,
					action: "create",
				});
	if (currentMode === "disabled" || recheckDecision === "deny") {
		const why =
			currentMode === "disabled"
				? `Operation '${pendingRun.action_key}' is now disabled on this connection.`
				: `Policy now denies '${pendingRun.action_key}' for the requesting principal.`;
		const reviewer = await resolveReviewer(ctx);
		await sql`
      UPDATE runs
      SET approval_status = 'rejected', status = 'cancelled',
          error_message = ${why}, completed_at = NOW()
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
        AND approval_status = 'pending'
    `;
		await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			`${pendingRun.action_key} — blocked by policy`,
			why,
			{ reason: why },
			reviewer,
		);
		return { error: `${why} The approval was cancelled.` };
	}

	const approvedInput = args.input ?? pendingRun.action_input ?? {};
	const validationError = validateOperationInput(
		resolved.operation,
		approvedInput,
	);
	if (validationError) {
		return {
			error: `Invalid input for operation '${resolved.operation.operation_key}': ${validationError}`,
		};
	}

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
		return { error: "Run not found or not pending approval" };
	}

	const run = runRows[0] as {
		id: number;
		connection_id: number;
		action_key: string;
		action_input: Record<string, unknown> | null;
	};

	const reviewer = await resolveReviewer(ctx);
	const eventId = await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"confirmed",
		`${run.action_key} — executing`,
		`Operation confirmed: ${run.action_key} — waiting for execution`,
		args.input ? { approved_input: args.input } : {},
		reviewer,
	);

	if (resolved.operation.backend === "local_action") {
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: "Operation approved. The worker will execute it shortly.",
		};
	}

	await sql`UPDATE runs SET status = 'running' WHERE id = ${args.run_id}`;
	const result = await executeOperationInline(
		args.run_id,
		ctx.organizationId,
		resolved.connection,
		resolved.operation,
		(run.action_input ?? {}) as Record<string, unknown>,
		env,
	);

	if (result.status === "completed") {
		await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"completed",
			`${run.action_key} — completed`,
			`Operation completed: ${run.action_key}`,
			{ output: result.output },
			reviewer,
		);
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: "Operation approved and executed.",
		};
	}

	await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"failed",
		`${run.action_key} — failed`,
		`Operation failed: ${run.action_key}${result.error_message ? ` — ${result.error_message}` : ""}`,
		{ error_message: result.error_message },
		reviewer,
	);
	return {
		action: "approve",
		approved: true,
		run_id: args.run_id,
		event_id: eventId,
		message: `Operation approved but execution failed: ${result.error_message}`,
	};
}

async function handleReject(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "reject");
	if (humanGate) return humanGate;
	await requireApprovalAuthority("reject", args.run_id, ctx);

	const sql = getDb();
	const reason = args.reason ?? "Rejected by user";
	const reviewer = await resolveReviewer(ctx);

	// Builder-gate run? Cancel it without touching the agents table.
	const claimedBuilder = await claimManageAgentsRun(
		args.run_id,
		ctx.organizationId,
		"rejected",
		reason,
	);
	if (claimedBuilder) {
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			`manage_agents.${claimedBuilder.proposal.action} — rejected`,
			`Builder action rejected: ${claimedBuilder.proposal.action} ${claimedBuilder.proposal.agent_id}${args.reason ? ` — ${args.reason}` : ""}`,
			{ reason },
			reviewer,
		);
		return {
			action: "reject",
			rejected: true,
			run_id: args.run_id,
			event_id: eventId,
		};
	}

	// Watcher field-change gate? Cancel it; the entity keeps its human-owned value.
	const fieldChangeReject = await tryRejectEntityChangeRun(args, ctx);
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
		return { error: "Run not found or not pending approval" };
	}

	const operationKey = (updated[0] as any).action_key;
	const eventId = await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"rejected",
		`${operationKey} — rejected`,
		`Operation rejected: ${operationKey}${args.reason ? ` — ${args.reason}` : ""}`,
		{ reason },
		reviewer,
	);

	return {
		action: "reject",
		rejected: true,
		run_id: args.run_id,
		event_id: eventId,
	};
}

/** Pending proposal runs a single watcher run produced, grouped by its window. */
async function pendingRunIdsForWindow(
	windowId: number,
	organizationId: string,
): Promise<number[]> {
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    SELECT id FROM runs
    WHERE window_id = ${windowId}
      AND organization_id = ${organizationId}
      AND approval_status = 'pending'
      AND run_type = 'internal'
    ORDER BY id ASC
  `;
	return rows.map((r) => Number(r.id));
}

/**
 * Approve every pending proposal a watcher run produced, in one action. Reuses
 * the single-run approve path per proposal so each still applies through its own
 * gate/apply handler — the batch is purely the grouping, not a second code path.
 */
async function handleApproveBatch(
	args: Static<typeof ApproveBatchAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "approve");
	if (humanGate) return humanGate;
	const runIds = await pendingRunIdsForWindow(args.window_id, ctx.organizationId);
	if (runIds.length === 0) {
		return {
			action: "approve_batch",
			window_id: args.window_id,
			approved_count: 0,
			failed_count: 0,
			run_ids: [],
			message: "No pending proposals for this run.",
		};
	}
	let approved = 0;
	let failed = 0;
	for (const runId of runIds) {
		const result = await handleApprove({ action: "approve", run_id: runId }, ctx, env);
		if ("error" in result) failed += 1;
		else approved += 1;
	}
	return {
		action: "approve_batch",
		window_id: args.window_id,
		approved_count: approved,
		failed_count: failed,
		run_ids: runIds,
		message: `Approved ${approved} of ${runIds.length} proposals${failed > 0 ? ` (${failed} failed)` : ""}.`,
	};
}

/**
 * The watcher + touched entities behind a window's proposal runs. Resolved from
 * the change_set event the watcher run recorded for this window (it carries both
 * watcher_id and the entity_ids the run touched), so the rejection feedback can
 * be keyed to the watcher and associated with those entities.
 */
async function resolveWindowRevisionContext(
	windowId: number,
	organizationId: string,
): Promise<{ watcherId: number | null; entityIds: number[] }> {
	const sql = getDb();
	const rows = await sql<{ watcher_id: string | null; entity_ids: unknown }>`
    SELECT (metadata->>'watcher_id')::bigint AS watcher_id, entity_ids
    FROM events
    WHERE organization_id = ${organizationId}
      AND semantic_type = 'change_set'
      AND (metadata->>'window_id')::bigint = ${windowId}
    ORDER BY id DESC
    LIMIT 1
  `;
	if (rows.length === 0) return { watcherId: null, entityIds: [] };
	return {
		watcherId: rows[0].watcher_id != null ? Number(rows[0].watcher_id) : null,
		// entity_ids arrives as a raw PG array string under fetch_types:false — never
		// call .map on it directly. parsePgNumberArray handles both string and array.
		entityIds: parsePgNumberArray(rows[0].entity_ids),
	};
}

/**
 * Reject every pending proposal a watcher run produced, feeding the reason back
 * so the watcher's next run revises (the conversational revision loop — no inline
 * diff editor). Reuses the single-run reject path per proposal, then records the
 * reason as a `correction` feedback event keyed to the watcher — the SAME channel
 * getRecentFeedbackSummary injects into future watcher runs. That closes the loop
 * for real: the run view shows why the batch was rejected AND the watcher's next
 * turn reads "Past Corrections from User Feedback" and adjusts, rather than the
 * feedback sitting inert (sol review #10).
 */
async function handleRejectBatch(
	args: Static<typeof RejectBatchAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "reject");
	if (humanGate) return humanGate;
	const runIds = await pendingRunIdsForWindow(args.window_id, ctx.organizationId);
	const reason = args.reason ?? "Rejected by user";
	let rejected = 0;
	for (const runId of runIds) {
		const result = await handleReject({ action: "reject", run_id: runId, reason }, ctx);
		if (!("error" in result)) rejected += 1;
	}
	if (rejected > 0) {
		const { watcherId, entityIds } = await resolveWindowRevisionContext(
			args.window_id,
			ctx.organizationId,
		);
		// A `correction` event — the durable, run-linked revision channel. Keyed to
		// the watcher (getRecentFeedbackSummary reads by watcher_id) and associated
		// with the entities the run touched, so both the watcher's next turn and the
		// entity/run views surface it. field_path='$batch_reject' marks it a
		// whole-run rejection (distinct from a single-field correction); the reason
		// rides `note`, which the summary renders verbatim.
		await insertEvent({
			entityIds,
			organizationId: ctx.organizationId,
			originId: `window_${args.window_id}_batch_reject`,
			title: `Batch rejected — ${rejected} proposals`,
			content: `The user rejected this run's proposals: ${reason}`,
			semanticType: "correction",
			createdBy: ctx.userId ?? null,
			metadata: {
				kind: "watcher_batch_reject",
				window_id: args.window_id,
				watcher_id: watcherId,
				field_path: "$batch_reject",
				mutation: "set",
				note: reason,
				rejected_count: rejected,
				reason,
			},
		});
	}
	return {
		action: "reject_batch",
		window_id: args.window_id,
		rejected_count: rejected,
		run_ids: runIds,
		message:
			rejected > 0
				? `Rejected ${rejected} proposals. The watcher's next run will see this feedback and revise.`
				: "No pending proposals for this run.",
	};
}

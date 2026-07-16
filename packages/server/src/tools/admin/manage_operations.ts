/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { executeCompiledConnector } from "@lobu/connector-worker/executor/runtime";
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
import { compileConnectionRowVisibility } from "../../authz/connection-visibility";
import {
	agentExistsInOrg,
	resolveActingPrincipal,
	resolveWatcherOwner,
	resolveWriteEffects,
	resolveWritePolicyDecision,
	watcherIdFromPrincipalId,
} from "../../authz/entity-policy";
import { authzScopeFromToolContext } from "../../authz/scope";
import {
	type DbClient,
	getDb,
	parsePgNumberArray,
	pgBigintArray,
	pgTextArray,
} from "../../db/client";
import type { Env } from "../../index";
import { callTool as callProxyTool } from "../../mcp-proxy/client";
import { notifyActionApprovalNeeded } from "../../notifications/triggers";
import {
	defaultActionModeForOperation,
	getActionModes,
	resolveActionMode,
} from "../../operations/action-modes";
import {
	getOperationForConnection,
	listOperations,
} from "../../operations/connector-operations";
import { executeHttpOperation } from "../../operations/execute-http-operation";
import { validateOperationInput } from "../../operations/input-validation";
import type {
	AvailableOperation,
	OperationDescriptor,
} from "../../operations/types";
import { createConnectorOperationRun } from "../../runs/queue-service";
import { resolveConnectorCodeForKey } from "../../utils/ensure-connector-installed";
import { resolveExecutionAuth } from "../../utils/execution-context";
import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import {
	buildConnectionsUrl,
	buildResourcePermalink,
} from "../../utils/url-builder";
import { trackWatcherReaction } from "../../utils/watcher-reactions";
import { dispatchChromeActionToExtension } from "../../worker-api/dispatch-chrome-action";
import { isAdminOrOwnerRole } from "../access-control";
import type { ToolContext } from "../registry";
import { getOrgUrlContext } from "../view-urls";
import { action, defineActionTool } from "./action-tool";
// Lives in its own module so dispatch-chrome-action does not import this file
// (breaks a circular init cycle that left MANAGE_WATCHERS_ACTION_KEY in TDZ).
import { waitForDeviceActionRun } from "./device-action-wait";
export { waitForDeviceActionRun };
import {
	applyEntityChangeProposal,
	ENTITY_CHANGE_ACTION_KEYS,
	type EntityChangeProposal,
} from "./entity-field-approval";
import { callerIsAdmin } from "./helpers/db-helpers";
import {
	applyManageAgentsProposal,
	MANAGE_AGENTS_ACTION_KEY,
	type ManageAgentsProposal,
} from "./manage_agents";
import {
	applyManageWatchersProposal,
	MANAGE_WATCHERS_ACTION_KEY,
	type ManageWatchersProposal,
} from "./manage_watchers";

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

type ExecutionTarget = {
	connection_id: number;
	slug: string;
	display_name: string;
	status: string;
	executable: boolean;
	reason: string;
};

type InternalExecutionTarget = ExecutionTarget & {
	config: Record<string, unknown> | null;
	auth_profile_kind: string | null;
};

type OperationTargetRow = {
	id: number;
	connector_key: string;
	slug: string;
	display_name: string | null;
	status: string;
	config: Record<string, unknown> | null;
	device_worker_id: string | null;
	device_online: boolean;
	device_bound: boolean;
	auth_profile_kind: string | null;
};

/**
 * The write-gate scope key for one connector operation: `${connector_key}::${op}`.
 * Operation keys (e.g. `send_message`, `create_issue`, `navigate`) are NOT unique
 * across connectors — Linear and GitHub both expose `create_issue`, chrome/macos/ios
 * all expose `navigate`. Binding a per-op policy row to the BARE key would make one
 * admin's rule silently gate every connector that shares the key. Qualifying by
 * connector_key scopes the rule to exactly the connector shown in the matrix. `::`
 * separates because operation keys themselves contain dots (`slack.send_message`).
 */
export function qualifiedOperationKey(
  connectorKey: string,
  operationKey: string,
): string {
  return `${connectorKey}::${operationKey}`;
}

const manageOperationsTool = defineActionTool("manage_operations", {
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
	return {
		...envStrings,
		...connectionCredentials,
		...(connectionConfig ?? {}),
	};
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

	let compiledCode: string;
	try {
		compiledCode = await resolveConnectorCodeForKey(
			connection.connector_key,
			connectorVersion ?? null,
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
	if (operation.backend_config.backend !== "mcp_tool") {
		return {
			status: "failed",
			error_message: "Invalid MCP operation backend config",
		};
  }

	let result: Awaited<ReturnType<typeof callProxyTool>>;
	try {
		result = await callProxyTool(
    connection.connector_key,
    {
      upstream_url: operation.backend_config.upstreamUrl,
				tool_prefix: "",
    },
    organizationId,
    operation.backend_config.toolName,
			actionInput,
			connection.id,
  );
	} catch (error) {
		return failRunInline(runId, organizationId, getErrorMessage(error));
	}

  if (result.isError) {
    const errorText =
      (result.content as Array<{ type: string; text?: string }>).find(
				(item) => item?.type === "text",
			)?.text ?? "Upstream MCP error";
    return failRunInline(runId, organizationId, errorText);
  }

	return completeRunInline(runId, organizationId, {
		content: result.content,
	} as Record<string, unknown>);
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
	if (operation.backend === "local_action") {
    return executeLocalActionInline(
      runId,
      organizationId,
      connection,
      operation,
      actionInput,
      env,
			abortSignal,
    );
  }
	if (operation.backend === "mcp_tool") {
		return executeMcpToolInline(
			runId,
			organizationId,
			connection,
			operation,
			actionInput,
		);
  }
	return executeHttpOperation(
		runId,
		organizationId,
		connection,
		operation,
		actionInput,
		abortSignal,
	);
}

function executionTargetFromRow(
	row: OperationTargetRow,
): InternalExecutionTarget {
	const base = {
		connection_id: Number(row.id),
		slug: row.slug,
		display_name: row.display_name ?? row.slug,
		config: row.config,
		auth_profile_kind: row.auth_profile_kind,
	};
	if (row.status !== "active") {
		return {
			...base,
			status: row.status,
			executable: false,
			reason: `Connection status is ${row.status}.`,
		};
	}
	if (row.device_bound && !row.device_online) {
		return {
			...base,
			status: "device_offline",
			executable: false,
			reason: "The connection's paired device is offline.",
		};
	}
	return {
		...base,
		status: "ready",
		executable: true,
		reason: "Connection is ready for execution.",
	};
}

function groupExecutionTargets(
	rows: OperationTargetRow[],
): Map<string, InternalExecutionTarget[]> {
	const grouped = new Map<string, InternalExecutionTarget[]>();
	for (const row of rows) {
		const targets = grouped.get(row.connector_key) ?? [];
		targets.push(executionTargetFromRow(row));
		grouped.set(row.connector_key, targets);
	}
	return grouped;
}

function operationReadinessReason(
	readiness: string,
	executable: boolean,
): string {
	if (executable) return "At least one visible connection is ready.";
	if (readiness === "disconnected") {
		return "No visible connection exists for this connector.";
	}
	if (readiness === "device_offline") {
		return "Every visible active device-bound connection is offline.";
	}
	if (readiness === "disabled") {
		return "This operation is disabled on every visible connection.";
	}
	return `A visible connection has status ${readiness}.`;
}

function resolveOperationReadiness(targets: ExecutionTarget[]): {
	readyTarget: ExecutionTarget | undefined;
	executable: boolean;
	readiness: string;
} {
	const readyTarget = targets.find((target) => target.executable);
	if (readyTarget) {
		return { readyTarget, executable: true, readiness: "ready" };
	}
	if (targets.length === 0) {
		return {
			readyTarget: undefined,
			executable: false,
			readiness: "disconnected",
		};
	}
	if (targets.every((target) => target.status === "disabled")) {
		return { readyTarget: undefined, executable: false, readiness: "disabled" };
	}
	return {
		readyTarget: undefined,
		executable: false,
		readiness:
			targets.find((target) => target.status !== "disabled")?.status ??
			"inactive",
	};
}

function operationMatchesQuery(
	operation: AvailableOperation & Record<string, unknown>,
	queryTokens: string[],
): boolean {
	if (queryTokens.length === 0) return true;
	const haystack = [
		operation.connector_key,
		operation.connector_name,
		operation.operation_key,
		operation.name,
		operation.description ?? "",
		JSON.stringify(operation.input_schema ?? {}),
	]
		.join(" ")
		.toLocaleLowerCase();
	return queryTokens.every((token) => haystack.includes(token));
}

function buildOperationNextAction(args: {
	operation: OperationDescriptor;
	readyTarget: ExecutionTarget | undefined;
	readiness: string;
	remediationTarget: ExecutionTarget | undefined;
	remediationConfig: Record<string, unknown> | null | undefined;
	remediationAuthKind: string | null | undefined;
	viewUrl: string | undefined;
}): Record<string, unknown> {
	const {
		operation,
		readyTarget,
		readiness,
		remediationTarget,
		remediationConfig,
		remediationAuthKind,
		viewUrl,
	} = args;
	if (readyTarget) {
		const requiredInput =
			Array.isArray(operation.input_schema?.required) &&
			operation.input_schema.required.length > 0;
		if (requiredInput) {
			return {
				action: "provide_input",
				sdk_method: "operations.execute",
				requires_input: true,
				input_schema: operation.input_schema,
				arguments: [
					{
						connection_id: readyTarget.connection_id,
						operation_key: operation.operation_key,
					},
				],
			};
		}
		return {
			action: "execute",
			sdk_method: "operations.execute",
			arguments: [
				{
					connection_id: readyTarget.connection_id,
					operation_key: operation.operation_key,
					input: {},
				},
			],
		};
	}
	if (readiness === "disconnected") {
		return {
			action: "connect",
			sdk_method: "connections.connect",
			arguments: [{ connector_key: operation.connector_key }],
		};
	}
	if (readiness === "disabled") {
		return {
			action: "enable_operation",
			sdk_method: "connections.update",
			arguments: [
				{
					connection_id: remediationTarget?.connection_id,
					config: {
						action_modes: {
							...getActionModes(remediationConfig),
							[operation.operation_key]:
								defaultActionModeForOperation(operation),
						},
					},
				},
			],
		};
	}
	if (readiness === "paused") {
		return {
			action: "resume_connection",
			sdk_method: "connections.update",
			arguments: [
				{ connection_id: remediationTarget?.connection_id, status: "active" },
			],
		};
	}
	if (
		["pending_auth", "error", "revoked"].includes(readiness) &&
		["interactive", "oauth_account"].includes(remediationAuthKind ?? "")
	) {
		return {
			action: "reauthenticate",
			sdk_method: "connections.reauthenticate",
			arguments: [remediationTarget?.connection_id],
			...(viewUrl ? { view_url: viewUrl } : {}),
		};
	}
	return {
		action:
			readiness === "device_offline" ? "bring_device_online" : "open_setup",
		manual: true,
		...(viewUrl ? { view_url: viewUrl } : {}),
	};
}

function buildAvailableOperation(args: {
	operation: OperationDescriptor;
	internalTargets: InternalExecutionTarget[];
	includeInputSchema: boolean;
	viewUrl: string | undefined;
}): AvailableOperation & Record<string, unknown> {
	const { operation, internalTargets, includeInputSchema, viewUrl } = args;
	const { backend_config: _privateBackendConfig, ...publicOperation } =
		operation;
	const targets = internalTargets.map((target): ExecutionTarget => {
		const {
			config,
			auth_profile_kind: _authProfileKind,
			...publicTarget
		} = target;
		if (resolveActionMode(operation, config) !== "disabled") {
			return publicTarget;
		}
		return {
			...publicTarget,
			status: "disabled",
			executable: false,
			reason: "This operation is disabled on the connection.",
		};
	});
	const { readyTarget, executable, readiness } =
		resolveOperationReadiness(targets);
	const remediationTarget =
		targets.find((target) => target.status === readiness) ?? targets[0];
	const remediationInternalTarget = internalTargets.find(
		(target) => target.connection_id === remediationTarget?.connection_id,
	);
	return {
		...(publicOperation as AvailableOperation),
		...(includeInputSchema ? {} : { input_schema: undefined }),
		executable,
		readiness,
		reason: operationReadinessReason(readiness, executable),
		connection_count: targets.length,
		execution_targets: targets,
		next_action: buildOperationNextAction({
			operation,
			readyTarget,
			readiness,
			remediationTarget,
			remediationConfig: remediationInternalTarget?.config,
			remediationAuthKind: remediationInternalTarget?.auth_profile_kind,
			viewUrl,
		}),
	};
}

async function loadVisibleOperationTargets(
	args: Static<typeof ListAvailableAction>,
	ctx: ToolContext,
): Promise<OperationTargetRow[]> {
	const visibility = compileConnectionRowVisibility(
		{
			...authzScopeFromToolContext(ctx),
			principalIsAdmin: await callerIsAdmin(getDb(), ctx),
		},
		"c",
	);
	return (await getDb().unsafe(
		`SELECT c.id,
		        c.connector_key,
		        c.slug,
		        c.display_name,
		        c.status,
		        c.config,
		        c.device_worker_id,
		        ap.profile_kind AS auth_profile_kind,
		        COALESCE(dw.last_seen_at > now() - interval '20 minutes', false) AS device_online,
		        (c.device_worker_id IS NOT NULL OR latest.runtime IS NOT NULL) AS device_bound
		 FROM connections c
		 LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
		 LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
		 LEFT JOIN LATERAL (
		   SELECT cd.runtime
		   FROM connector_definitions cd
		   WHERE cd.organization_id = c.organization_id
		     AND cd.key = c.connector_key
		     AND cd.status = 'active'
		   ORDER BY cd.updated_at DESC, cd.id DESC
		   LIMIT 1
		 ) latest ON TRUE
		 WHERE c.organization_id = $1
		   AND c.deleted_at IS NULL
		   ${visibility}
		   AND ($2::bigint IS NULL OR c.id = $2)
		   AND ($3::text IS NULL OR c.connector_key = $3)
		   AND ($4::bigint IS NULL OR EXISTS (
		     SELECT 1 FROM feeds f
		     WHERE f.connection_id = c.id
		       AND f.deleted_at IS NULL
		       AND $4 = ANY(f.entity_ids)
		   ))
		 ORDER BY c.connector_key, c.id`,
		[
			ctx.organizationId,
			args.connection_id ?? null,
			args.connector_key ?? null,
			args.entity_id ?? null,
		],
	)) as unknown as OperationTargetRow[];
}

async function handleListAvailable(
	args: Static<typeof ListAvailableAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const targetRows = await loadVisibleOperationTargets(args, ctx);

	// An explicit connection filter is also an authorization lookup. Fail with
	// execute's exact not-found error instead of a silent empty list: `[]` is
	// indistinguishable from "this connection declares no operations", and the
	// shared message keeps a hidden/private connection's connector key out of
	// the catalog without revealing whether the id exists at all. The
	// existence/visibility check is independent of the secondary filters: a
	// VISIBLE connection excluded by connector_key/entity_id is a normal empty
	// compound-filter match, while a hidden/missing id errors either way — so
	// the same visibility-compiled query is re-run with the secondary filters
	// stripped, only on this already-empty branch.
	if (args.connection_id !== undefined && targetRows.length === 0) {
		const bareRows =
			args.connector_key === undefined && args.entity_id === undefined
				? targetRows
				: await loadVisibleOperationTargets(
						{ ...args, connector_key: undefined, entity_id: undefined },
						ctx,
					);
		if (bareRows.length === 0) {
			return { error: "Connection not found or not visible." };
		}
		return {
			action: "list_available",
			operations: [],
			total: 0,
			limit: args.limit ?? 100,
			offset: args.offset ?? 0,
		};
	}

	const targetsByConnector = groupExecutionTargets(targetRows);

  // A `disabled` connector_action effect turns an operation OFF for this principal
  // — it shouldn't be listed at all (Disabled HIDES the action, unlike deny/approval
  // which surface then gate on execute). Two levels now: the BLANKET `execute` rule
  // (operation_key NULL) can disable the whole connector, and a PER-OPERATION rule
  // can disable a single op while the rest stay listed.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionWatcherId: ctx.actingWatcherId ?? null,
  });
  // Fetch the FULL filtered set (offset 0, no caller limit), drop per-op-disabled
  // ops across the WHOLE set, THEN paginate. Filtering a single page and subtracting
  // its hidden count from the global total gives an inconsistent `total` across pages
  // and can return a short page while visible ops remain past the offset (a client
  // treating "short page = end" would silently truncate the catalog). Pagination must
  // run on the post-filter list.
	// For an explicit connection, targetRows already performed the visibility and
	// authorization lookup. Query the connector catalog by that row's key instead
	// of applying listOperations' legacy per-connection action-mode filter; the
	// readiness mapper below must retain disabled capabilities and explain how to
	// enable them.
	const catalogConnectorKey =
		args.connection_id !== undefined
			? targetRows[0]?.connector_key
			: args.connector_key;
  const full = await listOperations({
    organizationId: ctx.organizationId,
		connectorKey: catalogConnectorKey,
    entityId: args.entity_id,
    kind: args.kind,
    backend: args.backend,
		// Required-input detection still needs the schema when the caller hides the
		// descriptor copy from the public response.
		includeInputSchema: true,
    includeOutputSchema: args.include_output_schema ?? false,
    // Fetch the WHOLE filtered set — listOperations defaults to limit 100, which
    // would silently drop ops past index 100 and make them unreachable at any
    // caller offset. We must filter per-op-disabled across the full set BEFORE
    // slicing, so no internal cap here; the caller's limit/offset apply below.
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
	const qualifiedWriteKeys = full.operations
		.filter((operation) => operation.kind === "write")
		.map((operation) =>
			qualifiedOperationKey(operation.connector_key, operation.operation_key),
		);
	const policyEffects = await resolveWriteEffects({
		organizationId: ctx.organizationId,
		resourceClass: "connector_action",
		principalKind: actor.kind,
		principalId: actor.id,
		ownerAgentId: actor.ownerAgentId,
		ownerResolved: actor.ownerResolved,
		action: "execute",
		operationKeys: qualifiedWriteKeys,
	});
	const blanketDisabled = policyEffects.get(null) === "disabled";

  // Hide WRITE ops whose per-op (or blanket) policy is disabled. Reads are never
  // filtered by agent write-policy. Humans always resolve auto for policy.
	const visibleFlags = full.operations.map((op) => {
			if (op.kind === "read") return "auto" as const;
			if (blanketDisabled) return "disabled" as const;
			return (
				policyEffects.get(
					qualifiedOperationKey(op.connector_key, op.operation_key),
				) ?? "auto"
  );
		});
	const policyVisible = full.operations.filter(
		(_op, i) => visibleFlags[i] !== "disabled",
  );

	const queryTokens = (args.query ?? "")
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	const connectorViewUrl = (connectorKey: string): string | undefined =>
		ownerSlug && baseUrl
			? buildConnectionsUrl(ownerSlug, baseUrl, connectorKey)
			: undefined;
	const publicOperations = policyVisible
		.map((operation) =>
			buildAvailableOperation({
				operation,
				internalTargets: targetsByConnector.get(operation.connector_key) ?? [],
				includeInputSchema: args.include_input_schema !== false,
				viewUrl: connectorViewUrl(operation.connector_key),
			}),
		)
		.filter((operation) => {
			if (args.include_disconnected === false && !operation.executable) {
				return false;
			}
			return operationMatchesQuery(operation, queryTokens);
		});

  const offset = args.offset ?? 0;
	const limit = args.limit ?? 100;
  return {
		action: "list_available",
		operations: publicOperations.slice(offset, offset + limit),
		total: publicOperations.length,
    limit,
    offset,
  };
}

// Poll `runs` until status flips to completed/failed/timeout or we hit
// our deadline. Used by handleExecute when the connector is device-
// bound — the gateway can't execute inline; it inserts a pending run
// and waits for the device worker (chrome extension / mac bridge /
// etc.) to claim, run, and POST /api/workers/complete-action.
//
async function handleExecute(
	args: Static<typeof ExecuteAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	const visibility = compileConnectionRowVisibility(
		{
			...authzScopeFromToolContext(ctx),
			principalIsAdmin: await callerIsAdmin(sql, ctx),
		},
		"c",
	);
	const visibleRows = await sql.unsafe(
		`SELECT 1
		 FROM connections c
		 WHERE c.organization_id = $1
		   AND c.id = $2
		   AND c.deleted_at IS NULL
		   ${visibility}
		 LIMIT 1`,
		[ctx.organizationId, args.connection_id],
	);
	if (visibleRows.length === 0) {
		return {
			error: "Connection not found or not visible.",
		};
	}
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
	// Resolve WHO is acting through the single seam — merges the explicit
	// watcher_source and the reaction session's own watcher, looks up the owning
	// agent, and pins autonomous mode for a watcher. Persisted with the run so the
	// approve-time recheck re-evaluates in the SAME mode/principal.
	const actor = await resolveActingPrincipal(sql, {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitWatcherId: args.watcher_source?.watcher_id ?? null,
		sessionWatcherId: ctx.actingWatcherId ?? null,
	});
	// Agent write-policy applies to WRITE ops only. Reads stay available under
	// connection action_modes alone (default auto) — same idea as MCP readOnlyHint.
	const policyDecision =
		operation.kind === "read"
			? "allow"
			: await resolveWritePolicyDecision({
					organizationId: ctx.organizationId,
					resourceClass: "connector_action",
					principalKind: actor.kind,
					principalId: actor.id,
					ownerAgentId: actor.ownerAgentId,
					ownerResolved: actor.ownerResolved,
					action: "execute",
					// A per-operation rule (e.g. deliveroo::place_order = approval) tightens the
					// blanket execute for this op alone; the blanket applies to every other op. The
					// key is connector-qualified so the rule can't leak to another connector that
					// exposes the same bare operation key.
					operationKey: qualifiedOperationKey(
						connection.connector_key,
						operation.operation_key,
					),
				});
	if (policyDecision === "deny") {
		return {
			error: `Policy denies '${operation.operation_key}' for this principal.`,
		};
	}
	const shouldQueue =
		mode === "approval" || policyDecision === "require_approval";

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
		// at approve time against who queued it, not who approves it (sol #5) —
		// and in the SAME acting mode, so an autonomous run's tighter autonomous
		// rule isn't lost to an attended recheck.
		policyPrincipalKind: actor.kind,
		policyPrincipalId: actor.id,
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
		action: "list_runs",
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
	if (rows.length === 0) return { error: "Run not found" };
	return { action: "get_run", run: rows[0] };
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
	db: DbClient = getDb(),
): Promise<number | undefined> {
  const sql = db;
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
	}, { sql });

	return Number(nextEvent.id);
}

/**
 * Resolve the acting user's display name for the approval audit trail. Approvals
 * are web-session only (`ctx.clientId` is rejected upstream), so `ctx.userId` is
 * always a real human here; we still guard on null for safety.
 */
async function resolveReviewer(
	ctx: ToolContext,
): Promise<ApprovalReviewer | null> {
  if (!ctx.userId) return null;
  const rows = await getDb()<{ name: string | null }>`
    SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1
  `;
  return { userId: ctx.userId, name: rows[0]?.name ?? null };
}

/**
 * Builder-gate approval handler: the per-family knobs the ONE generic
 * claim/approve/reject path varies over. manage_agents and manage_watchers both
 * queue a pending `run_type='internal'` run keyed by `action_key`, hold the
 * proposal in `action_input`, and apply it via `apply(proposal, ctx, env,
 * ownerUserId)` on approval — so the whole lifecycle is shared and only these
 * fields differ. Add a new builder family by registering another handler here.
 */
interface BuilderApprovalHandler {
	/** `runs.action_key` this family's pending rows carry. */
	actionKey: string;
	/** Noun for the result message, e.g. "Agent" / "Watcher". */
	nounLabel: string;
	/** The proposal shape stored in `action_input` is valid for this family. */
	isValidProposal(proposal: unknown): boolean;
	/** Apply the held proposal on approval (the family's write handler). */
	apply(
		proposal: unknown,
		ctx: ToolContext,
		env: Env,
		ownerUserId: string | null,
	): Promise<unknown>;
	/** One-line action id for event summaries, e.g. `create agent-7`. */
	describe(proposal: unknown): string;
	/**
	 * Optional soft-failure detector for handlers that return `{ error }` /
	 * partial-failure summaries instead of throwing (manage_watchers). A non-null
	 * string marks the apply failed even though it didn't throw.
	 */
	detectSoftFailure?(output: unknown): string | null;
}

/**
 * Soft failures from manage_watchers write handlers that return errors instead
 * of throwing. create throws (ToolUserError); update returns `{ error: string }`
 * for invalid cron/timezone; delete returns a summary with per-id results and
 * never throws on individual archive failures. Partial delete success (some
 * succeeded, some failed) is treated as completed — the summary is preserved in
 * action_output so the reviewer can see which ids failed.
 */
function detectManageWatchersApplyFailure(output: unknown): string | null {
	if (!output || typeof output !== "object") return null;
	const result = output as Record<string, unknown>;
	if (result.error) {
		return typeof result.error === "string"
			? result.error
			: String(result.error);
	}
	const summary = result.summary as
		| { total?: number; successful?: number; failed?: number }
		| undefined;
	if (
		summary &&
		typeof summary.failed === "number" &&
		summary.failed > 0 &&
		summary.successful === 0
	) {
		const total =
			typeof summary.total === "number" ? summary.total : summary.failed;
		return `Watcher delete failed: 0 of ${total} succeeded`;
	}
	return null;
}

// Lazy: BUILDER_APPROVAL_HANDLERS used to be a top-level const that read
// MANAGE_WATCHERS_ACTION_KEY during module init. Under the circular graph
// manage_operations → dispatch-chrome / manage_watchers → … → manage_operations,
// that access hit TDZ and red-failed CI unit (`Cannot access 'MANAGE_WATCHERS_ACTION_KEY'
// before initialization`). Defer until first call after all modules settle.
let builderApprovalHandlers: BuilderApprovalHandler[] | null = null;
function getBuilderApprovalHandlers(): BuilderApprovalHandler[] {
	if (builderApprovalHandlers) return builderApprovalHandlers;
	builderApprovalHandlers = [
		{
			actionKey: MANAGE_AGENTS_ACTION_KEY,
			nounLabel: "Agent",
			isValidProposal: (p) => p != null,
			apply: (p, ctx, env, owner) =>
				applyManageAgentsProposal(p as ManageAgentsProposal, ctx, env, owner),
			describe: (p) => {
				const proposal = p as ManageAgentsProposal;
				return `${proposal.action} ${proposal.agent_id}`;
			},
		},
		{
			actionKey: MANAGE_WATCHERS_ACTION_KEY,
			nounLabel: "Watcher",
			isValidProposal: (p) =>
				(p as ManageWatchersProposal | null)?.args != null,
			apply: (p, ctx, env, owner) =>
				applyManageWatchersProposal(
					p as ManageWatchersProposal,
					ctx,
					env,
					owner,
				),
			describe: (p) => (p as ManageWatchersProposal).args.action,
			detectSoftFailure: detectManageWatchersApplyFailure,
		},
	];
	return builderApprovalHandlers;
}

/**
 * Atomically claim a pending builder-gate run for ANY registered family. The
 * `action_key = ANY(...)` predicate + `RETURNING action_key` lets one query
 * cover every family and hand back the matching handler. Returns null when this
 * run_id isn't a pending builder run (caller falls through to the next approval
 * path). `run_type = 'internal'` scopes to builder runs; connector-operation
 * runs (`run_type='action'`) are handled separately.
 */
async function claimBuilderRun(
	runId: number,
	organizationId: string,
	decision: "approved" | "rejected",
	rejectReason?: string,
): Promise<{
	handler: BuilderApprovalHandler;
	proposal: unknown;
	requesterUserId: string | null;
} | null> {
	const sql = getDb();
	const handlers = getBuilderApprovalHandlers();
	const actionKeys = pgTextArray(handlers.map((h) => h.actionKey));
	const rows =
		decision === "approved"
			? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running'
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys})
          RETURNING action_input, created_by_user_id, action_key
        `
			: await sql`
          UPDATE runs
          SET approval_status = 'rejected', status = 'cancelled',
              error_message = ${rejectReason ?? "Rejected by user"}, completed_at = NOW()
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys})
          RETURNING action_input, created_by_user_id, action_key
        `;
	if (rows.length === 0) return null;
	const row = rows[0] as {
		action_input: unknown;
		created_by_user_id: string | null;
		action_key: string;
	};
	const handler = handlers.find((h) => h.actionKey === row.action_key);
	if (!handler || !handler.isValidProposal(row.action_input)) return null;
	return {
		handler,
		proposal: row.action_input,
		requesterUserId: row.created_by_user_id,
	};
}

/** Mark a claimed builder run failed + supersede its card to 'failed'. */
async function failBuilderRun(
	runId: number,
	organizationId: string,
	handler: BuilderApprovalHandler,
	desc: string,
	errorMessage: string,
	reviewer: ApprovalReviewer | null,
): Promise<ManageOperationsResult> {
	await getDb()`
    UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage}
    WHERE id = ${runId} AND organization_id = ${organizationId}
  `;
	const eventId = await supersedeActionEvent(
		runId,
		organizationId,
		"failed",
		`${handler.actionKey}.${desc} — failed`,
		`Builder action failed: ${desc} — ${errorMessage}`,
		{ error_message: errorMessage },
		reviewer,
	);
	return {
		action: "approve",
		approved: true,
		run_id: runId,
		event_id: eventId,
		message: `${handler.nounLabel} ${desc} approved but failed: ${errorMessage}`,
	};
}

/**
 * Approve + apply a builder-gate run of ANY registered family. Returns a result
 * when the run was a pending builder run; null to fall through to the next
 * approval path. Routes terminal events through {@link supersedeActionEvent}
 * (supersedesEventId is passed explicitly — origin-based auto-supersede needs a
 * non-null connection_id, which internal approval events don't have).
 */
async function tryApproveBuilderRun(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult | null> {
	const claimed = await claimBuilderRun(
		args.run_id,
		ctx.organizationId,
		"approved",
	);
	if (!claimed) return null;

	const { handler, proposal, requesterUserId } = claimed;
	const desc = handler.describe(proposal);
	const reviewer = await resolveReviewer(ctx);
	await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"confirmed",
		`${handler.actionKey}.${desc} — executing`,
		`Builder action confirmed: ${desc}`,
		{},
		reviewer,
	);

	try {
		const output = await handler.apply(proposal, ctx, env, requesterUserId);
		// Some handlers return `{ error }` / partial-failure summaries instead of
		// throwing — treat those as failures so the run isn't marked completed
		// when nothing applied.
		const softFailure = handler.detectSoftFailure?.(output) ?? null;
		if (softFailure) {
			return failBuilderRun(
				args.run_id,
				ctx.organizationId,
				handler,
				desc,
				softFailure,
				reviewer,
			);
		}
		await getDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${getDb().json(output as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"completed",
			`${handler.actionKey}.${desc} — completed`,
			`Builder action completed: ${desc}`,
			{ output: output as unknown as Record<string, unknown> },
			reviewer,
		);
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: `${handler.nounLabel} ${desc} approved and applied.`,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return failBuilderRun(
			args.run_id,
			ctx.organizationId,
			handler,
			desc,
			errorMessage,
			reviewer,
		);
	}
}

/**
 * Reject a builder-gate run of ANY registered family: cancel it without
 * applying the held mutation + supersede its card to 'rejected'. Returns a
 * result when the run was a pending builder run; null to fall through.
 */
async function tryRejectBuilderRun(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
	reason: string,
	reviewer: ApprovalReviewer | null,
): Promise<ManageOperationsResult | null> {
	const claimed = await claimBuilderRun(
		args.run_id,
		ctx.organizationId,
		"rejected",
		reason,
	);
	if (!claimed) return null;

	const { handler, proposal } = claimed;
	const desc = handler.describe(proposal);
	const eventId = await supersedeActionEvent(
		args.run_id,
		ctx.organizationId,
		"rejected",
		`${handler.actionKey}.${desc} — rejected`,
		`Builder action rejected: ${desc}${args.reason ? ` — ${args.reason}` : ""}`,
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

/**
 * Claim a pending entity-change run held for approval. Mirrors claimBuilderRun.
 * Returns the held proposal, or null when this run is not a pending entity
 * change.
 */
async function claimEntityChangeRun(
	runId: number,
	organizationId: string,
	decision: "approved" | "rejected",
	rejectReason?: string,
	db: DbClient = getDb(),
): Promise<{ proposal: EntityChangeProposal } | null> {
	const sql = db;
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
              error_message = ${rejectReason ?? "Rejected by user"}, completed_at = NOW()
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
): "create" | "update" | "delete" | "merge" {
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
	if (operation === "merge") {
		const mergeProposal = proposal as Extract<
			EntityChangeProposal,
			{ operation: "merge" }
		>;
		const duplicates = mergeProposal.current.duplicates ?? [
			mergeProposal.current.loser,
		];
		return `${duplicates.map((entity) => String(entity.name ?? `entity ${entity.id}`)).join(", ")} into ${String(mergeProposal.current.winner.name ?? `entity ${mergeProposal.winner_entity_id}`)}`;
	}
	return (proposal as Extract<EntityChangeProposal, { operation: "create" }>)
		.entity_data.name;
}

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
 * Approving or rejecting a run is a HUMAN decision — it must come from a verified
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
	const sql = getDb();
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const [pending] = await sql<{ action_input: EntityChangeProposal | null }>`
		SELECT action_input
		FROM runs
		WHERE id = ${args.run_id}
		  AND organization_id = ${ctx.organizationId}
		  AND run_type = 'internal'
		  AND action_key = ANY(${actionKeys}::text[])
		  AND approval_status = 'pending'
		  AND status = 'pending'
		LIMIT 1
	`;
	if (!pending?.action_input) return null;
	const pendingProposal = pending.action_input;
	const pendingOperation = entityChangeOperation(pendingProposal);
	const reviewer = await resolveReviewer(ctx);

	const completeApproval = async (
		db: DbClient,
		proposal: EntityChangeProposal,
	): Promise<ManageOperationsResult> => {
		const operation = entityChangeOperation(proposal);
		const description = describeEntityChange(proposal);
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
			db,
		);

		const result = await applyEntityChangeProposal(proposal, ctx, env, db);
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
		await db`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${db.json(result as unknown as Record<string, unknown>)}
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
			db,
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
	};

	const applyFailure = async (
		error: unknown,
	): Promise<ManageOperationsResult> => {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Apply failures here are often transient/situational (entity gained
		// children before a non-force delete, schema changed, etc.). Put the run
		// BACK to pending instead of burning the proposal on one errant click —
		// the reviewer can retry after fixing the blocker, or reject it.
		const reset = await sql`
      UPDATE runs SET approval_status = 'pending', status = 'pending', error_message = ${errorMessage}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
		AND (
		  (approval_status = 'approved' AND status = 'running')
		  OR (approval_status = 'pending' AND status = 'pending')
		)
		RETURNING id
    `;
		if (reset.length === 0) {
			return {
				error: `Failed to apply entity ${pendingOperation}: ${errorMessage}. The approval changed concurrently; refresh before retrying.`,
			};
		}
		await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"apply_failed",
			pendingOperation === "update"
				? "entity_field_change — apply failed, still pending"
				: `entity_${pendingOperation} — apply failed, still pending`,
			`Applying the approved change failed: ${errorMessage}. The approval is pending again — fix the blocker and approve once more, or reject it.`,
			{ error_message: errorMessage },
			reviewer,
		);
		return {
			error: `Failed to apply entity ${pendingOperation}: ${errorMessage}. The approval is back to pending — approve again after fixing the blocker, or reject it.`,
		};
	};

	if (pendingOperation === "merge") {
		try {
			return await sql.begin(async (tx) => {
				const claimed = await claimEntityChangeRun(
					args.run_id,
					ctx.organizationId,
					"approved",
					undefined,
					tx,
				);
				if (!claimed) return null;
				return completeApproval(tx, claimed.proposal);
			});
		} catch (error) {
			return applyFailure(error);
		}
	}

	const claimed = await claimEntityChangeRun(
		args.run_id,
		ctx.organizationId,
		"approved",
	);
	if (!claimed) return null;
	try {
		return await completeApproval(sql, claimed.proposal);
	} catch (error) {
		return applyFailure(error);
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

	// Builder-gate runs (manage_agents / manage_watchers create/update/delete)
	// reuse this same durable approval path but have run_type='internal' + no
	// connection. One generic path applies them via their registered handler
	// rather than the connector-operation executor.
	const builderResult = await tryApproveBuilderRun(args, ctx, env);
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
	// A watcher-attributed run must fold its OWNING AGENT'S envelope at recheck too,
	// exactly as at queue time — else an agent-level deny installed before approval
	// would be missed. Re-resolve the owner from the persisted `watcher:<id>` id
	// (no need to persist it separately).
	const recheckWatcherId = watcherIdFromPrincipalId(
		pendingRun.policy_principal_id,
	);
	// Re-resolve the principal's resolvability from persistence. A WATCHER principal
	// re-resolves its owning agent via `watcher:<id>`. A direct AGENT principal must be
	// existence-checked too: if the agent was DELETED between queue and approve, the
	// r16 cascade removed its deny/approval rows, so folding candidates for a gone
	// agent would fall back to the looser org default (connector_action → auto) and let
	// a human's Approve execute the run as a deleted agent — strictly looser than
	// before the delete. Either GONE → resolved:false → resolveWriteEffect denies,
	// cancelling the approval. (Same fail-closed invariant resolveActingPrincipal
	// enforces for live sessions; this is the persisted-principal path.)
	let recheckOwner: { ownerAgentId: string | null; resolved: boolean };
	if (recheckWatcherId != null) {
		recheckOwner = await resolveWatcherOwner(
			sql,
			recheckWatcherId,
			ctx.organizationId,
		);
	} else if (
		recheckPrincipalKind === "agent" &&
		pendingRun.policy_principal_id != null
	) {
		recheckOwner = {
			ownerAgentId: null,
			resolved: await agentExistsInOrg(
				sql,
				pendingRun.policy_principal_id,
				ctx.organizationId,
			),
		};
	} else {
		recheckOwner = { ownerAgentId: null, resolved: true };
	}
	const recheckDecision =
		recheckPrincipalKind === "user"
			? "allow"
			: await resolveWritePolicyDecision({
					organizationId: ctx.organizationId,
					resourceClass: "connector_action",
					principalKind: recheckPrincipalKind,
					principalId: pendingRun.policy_principal_id,
					ownerAgentId: recheckOwner.ownerAgentId,
					ownerResolved: recheckOwner.resolved,
					action: "execute",
					// Recheck against the SAME operation the run was queued under, using the
					// connector-qualified key (connector_key from the resolved connection +
					// the persisted action_key), so a per-op rule installed after queueing
					// still binds — mirrors the queue-time gate above.
					operationKey: qualifiedOperationKey(
						resolved.connection.connector_key,
						pendingRun.action_key,
					),
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

	// Builder-gate run? Cancel it without applying the held mutation.
	const builderReject = await tryRejectBuilderRun(args, ctx, reason, reviewer);
	if (builderReject) return builderReject;

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
	const runIds = await pendingRunIdsForWindow(
		args.window_id,
		ctx.organizationId,
	);
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
		const result = await handleApprove(
			{ action: "approve", run_id: runId },
			ctx,
			env,
		);
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
	const runIds = await pendingRunIdsForWindow(
		args.window_id,
		ctx.organizationId,
	);
	const reason = args.reason ?? "Rejected by user";
	let rejected = 0;
	for (const runId of runIds) {
		const result = await handleReject(
			{ action: "reject", run_id: runId, reason },
			ctx,
		);
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

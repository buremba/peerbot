import { executeCompiledConnector } from "@lobu/connector-worker/executor/runtime";
import { getErrorMessage } from "@lobu/core";
import { ExecuteAction, type ManageOperationsResult } from "../schemas";
import type { Static } from "@sinclair/typebox";
import { readGrantedScopesFromAuthData } from "../../../../auth/oauth/scopes";
import { resolveBehaviorConnectionVisibilityUserId } from "../../../../authz/behavior-connection-visibility";
import { compileConnectionRowVisibility } from "../../../../authz/connection-visibility";
import { resolveActingPrincipal, resolveWritePolicyDecision } from "../../../../authz/entity-policy";
import { authzScopeFromToolContext } from "../../../../authz/scope";
import { getDb } from "../../../../db/client";
import type { Env } from "../../../../index";
import { currentMcpActivityAttribution, currentMcpActivityEventMetadata } from "../../../../lobu/stores/mcp-client-conversations";
import { callTool as callProxyTool } from "../../../../mcp-proxy/client";
import { notifyActionApprovalNeeded } from "../../../../notifications/triggers";
import { resolveActionMode } from "../../../../operations/action-modes";
import { getOperationForConnection } from "../../../../operations/connector-operations";
import { executeHttpOperation } from "../../../../operations/execute-http-operation";
import { validateOperationInput } from "../../../../operations/input-validation";
import { getMissingKnownOAuthScopes } from "../../../../operations/oauth-scope-readiness";
import type { OperationDescriptor } from "../../../../operations/types";
import {
	DEFAULT_PAGE_ACTIVATION_SECONDS,
	normalizePageActivationUrls,
} from "../../../../runs/page-activation";
import { createConnectorOperationRun } from "../../../../runs/queue-service";
import { getAuthProfileById } from "../../../../utils/auth-profiles";
import { resolveConnectorCodeForKey } from "../../../../utils/ensure-connector-installed";
import { ToolUserError } from "../../../../utils/errors";
import { resolveExecutionAuth } from "../../../../utils/execution-context";
import { insertEvent } from "../../../../utils/insert-event";
import logger from "../../../../utils/logger";
import { buildResourcePermalink } from "../../../../utils/url-builder";
import { trackWatcherReaction } from "../../../../utils/watcher-reactions";
import { dispatchChromeActionToExtension } from "../../../../worker-api/dispatch-chrome-action";
import type { ToolContext } from "../../../registry";
import { getOrgUrlContext } from "../../../view-urls";
import { waitForDeviceActionRun } from "../../device-action-wait";
import { callerIsAdmin } from "../../helpers/db-helpers";
import {
	qualifiedOperationKey,
	type ConnectionRow,
	type InlineExecutionResult,
} from "./shared";
// Update the run to failed status and return the error result in one call.
// When `deferTerminalWrite` is set the runs write is skipped — the caller
// (approve's phase 2) persists the terminal state AND the card event in one
// transaction, so the executor must not commit the run terminal state first.
async function failRunInline(
	runId: number,
	organizationId: string,
	errorMsg: string,
	deferTerminalWrite = false,
): Promise<InlineExecutionResult> {
	if (!deferTerminalWrite) {
		const sql = getDb();
		await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMsg} WHERE id = ${runId} AND organization_id = ${organizationId}`;
	}
	return { status: "failed", error_message: errorMsg };
}

// Update the run to completed status and return the output in one call.
async function completeRunInline(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
	deferTerminalWrite = false,
): Promise<InlineExecutionResult> {
	if (!deferTerminalWrite) {
		const sql = getDb();
		await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(output)} WHERE id = ${runId} AND organization_id = ${organizationId}`;
	}
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
	requesterUserId: string | null,
	env: Env,
	abortSignal?: AbortSignal,
	deferTerminalWrite = false,
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
			organizationId,
			connectorVersion ?? null,
		);
	} catch (err) {
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(err),
			deferTerminalWrite,
		);
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
				// extension (the Lobu Team Deliveroo connector scrapes restaurant
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
						visibilityUserId: requesterUserId,
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
		return completeRunInline(
			runId,
			organizationId,
			result.output,
			deferTerminalWrite,
		);
	} catch (error) {
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(error),
			deferTerminalWrite,
		);
	}
}

async function executeMcpToolInline(
	runId: number,
	organizationId: string,
	connection: ConnectionRow,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	deferTerminalWrite = false,
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
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(error),
			deferTerminalWrite,
		);
	}

  if (result.isError) {
    const errorText =
      (result.content as Array<{ type: string; text?: string }>).find(
				(item) => item?.type === "text",
			)?.text ?? "Upstream MCP error";
    return failRunInline(
      runId,
      organizationId,
      errorText,
      deferTerminalWrite,
    );
  }

	return completeRunInline(
		runId,
		organizationId,
		{
			content: result.content,
		} as Record<string, unknown>,
		deferTerminalWrite,
	);
}

/**
 * Options for {@link executeOperationInline}.
 */
interface InlineExecutionOptions {
	/**
	 * Skip the executor's terminal `runs` write. Used by approve's phase 2:
	 * the terminal run state and its card event must commit together, so the
	 * executor cannot commit the run terminal state on the pool first (that
	 * would leave a terminal run with no card when the card INSERT fails).
	 */
	deferTerminalWrite?: boolean;
}

export async function executeOperationInline(
	runId: number,
	organizationId: string,
	connection: ConnectionRow,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	requesterUserId: string | null,
	env: Env,
	abortSignal?: AbortSignal,
	options?: InlineExecutionOptions,
): Promise<InlineExecutionResult> {
	const deferTerminalWrite = options?.deferTerminalWrite ?? false;
	if (operation.backend === "local_action") {
		return executeLocalActionInline(
			runId,
			organizationId,
			connection,
			operation,
			actionInput,
			requesterUserId,
			env,
			abortSignal,
			deferTerminalWrite,
		);
	}
	if (operation.backend === "mcp_tool") {
		return executeMcpToolInline(
			runId,
			organizationId,
			connection,
			operation,
			actionInput,
			deferTerminalWrite,
		);
	}
	return executeHttpOperation(
		runId,
		organizationId,
		connection,
		operation,
		actionInput,
		abortSignal,
		deferTerminalWrite,
	);
}
/** Return the durable outcome of a run claimed by an earlier request. */
async function replayExistingOperationRun(
	claim: Awaited<ReturnType<typeof createConnectorOperationRun>>,
	operationName: string,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	if (claim.approvalStatus === "pending" && claim.status === "pending") {
		const eventRows = await sql<{ id: number }>`
			SELECT id
			FROM events
			WHERE organization_id = ${ctx.organizationId}
			  AND run_id = ${claim.runId}
			  AND interaction_type = 'approval'
			ORDER BY id DESC
			LIMIT 1
		`;
		const { ownerSlug: orgSlug, baseUrl } = await getOrgUrlContext(ctx);
		const approvalUrl = buildResourcePermalink(
			orgSlug,
			{ kind: "run", runId: claim.runId },
			baseUrl,
		);
		return {
			action: "execute",
			run_id: claim.runId,
			...(eventRows[0] ? { event_id: Number(eventRows[0].id) } : {}),
			approval_url: approvalUrl,
			status: "pending_approval",
			message: `Operation '${operationName}' requires approval. Share the approval_url with the user to confirm.`,
		};
	}

	if (claim.status === "completed") {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "completed",
			output: claim.actionOutput ?? {},
		};
	}
	if (claim.status === "timeout") {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "timeout",
			error_message: claim.errorMessage ?? `Run ${claim.runId} timed out.`,
		};
	}
	if (["pending", "claimed", "running"].includes(claim.status)) {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "in_progress",
			message: `Idempotent operation run ${claim.runId} is already in progress.`,
		};
	}
	return {
		action: "execute",
		run_id: claim.runId,
		status: "failed",
		error_message:
			claim.errorMessage ??
			`Run ${claim.runId} ended with status '${claim.status}'.`,
	};
}

// Device-bound execution inserts a pending run and waits for the device worker
// (Chrome extension / Mac bridge / etc.) to claim it and post completion.
export async function handleExecute(
	args: Static<typeof ExecuteAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	if (
		args.idempotency_key != null &&
		args.idempotency_key !== args.idempotency_key.trim()
	) {
		throw new ToolUserError(
			"idempotency_key must not have leading or trailing whitespace.",
			422,
		);
	}
	const visibilityUserId = await resolveBehaviorConnectionVisibilityUserId(
		ctx,
		sql,
	);
	const visibility = compileConnectionRowVisibility(
		{
			...authzScopeFromToolContext(ctx),
			principal: visibilityUserId,
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

	const requiredScopes = operation.required_scopes ?? [];
	if (requiredScopes.length > 0) {
		const authProfile = await getAuthProfileById(
			ctx.organizationId,
			connection.auth_profile_id,
		);
		const missingScopes = getMissingKnownOAuthScopes(
			readGrantedScopesFromAuthData(authProfile?.auth_data),
			Object.hasOwn(authProfile?.auth_data ?? {}, "granted_scopes"),
			requiredScopes,
		);
		if (missingScopes.length > 0) {
			return {
				error: `Operation '${operation.operation_key}' requires additional OAuth consent for scope(s): ${missingScopes.join(", ")}. Reauthorize the connection and complete consent, then retry operations.execute with the same arguments. The operation will not resume automatically.`,
			};
		}
	}

	const input = args.input ?? {};
	// A caller-provided behavior_source is only an attribution hint. Durable
	// feedback must follow the server-stamped Behavior execution context.
	const reactionBehaviorId = ctx.actingWatcherId ?? null;
	const reactionWindowId = ctx.actingWindowId ?? null;
	const trackOperationReaction = async (runId: number): Promise<void> => {
		if (reactionBehaviorId === null || reactionWindowId === null) return;
		await trackWatcherReaction({
			organizationId: ctx.organizationId,
			watcherId: reactionBehaviorId,
			windowId: reactionWindowId,
			reactionType: "action_executed",
			toolName: "manage_operations",
			toolArgs: {
				operation_key: args.operation_key,
				connection_id: args.connection_id,
				input,
			},
			runId,
		});
	};
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
	// behavior_source and the reaction session's own watcher, looks up the owning
	// agent, and pins autonomous mode for a watcher. Persisted with the run so the
	// approve-time recheck re-evaluates in the SAME mode/principal.
	const actor = await resolveActingPrincipal(sql, {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitWatcherId: args.behavior_source?.behavior_id ?? null,
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
	if (args.activation && shouldQueue) {
		throw new ToolUserError(
			"Page-activated operations cannot also require human approval.",
			422,
		);
	}
	const activation = args.activation
		? {
				kind: args.activation.kind,
				urls: normalizePageActivationUrls(args.activation.urls),
				expiresInSeconds:
					args.activation.expires_in_seconds ??
					DEFAULT_PAGE_ACTIVATION_SECONDS,
			}
		: undefined;
	// Activation is claimed by the owning user's own browser; a run with no
	// resolvable owner could never match a worker and would park until timeout.
	if (activation && !visibilityUserId) {
		throw new ToolUserError(
			"Page activation requires an operation owned by a resolvable user.",
			422,
		);
	}

	// Intrinsically device-only connectors always execute on their connector
	// runtime. Otherwise, a physical connection pin is exact operation
	// placement. The sole exception is a non-Chrome connector pinned to a
	// chrome-extension: that pin selects delegated scrape affinity for inline
	// connector work; it does not move the parent operation onto the extension.
	const isChromeScrapeAffinity =
		connection.device_platform === "chrome-extension" &&
		!connection.connector_key.startsWith("chrome");
	const executesOnDevice =
		connection.connector_runtime != null ||
		(connection.device_worker_id != null && !isChromeScrapeAffinity);
	if (activation && (operation.backend !== "local_action" || executesOnDevice)) {
		throw new ToolUserError(
			"Page activation requires a server-executed local connector operation.",
			422,
		);
	}

	const approvalMode: "inline" | "queued" | "device" = shouldQueue
		? "queued"
		: executesOnDevice
			? "device"
			: "inline";

	// Queued (approval) runs bind run creation to the pending approval EVENT in
	// ONE transaction (#2033 item 16): if the event write fails, the run must
	// not exist — otherwise the run is durably pending but the /memory approval
	// page (events-only) shows nothing and the agent can never approve it.
	// Device/inline runs have no approval event, so they create the run on the
	// pool as before.
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
		const entityIds =
			entityIdsLiteral && typeof entityIdsLiteral === "string"
				? entityIdsLiteral
						.replace(/[{}]/g, "")
						.split(",")
						.filter(Boolean)
						.map(Number)
				: [];

		// Atomic: run + approval event commit together or not at all. Both writes
		// run on `tx`; insertEvent threads it via options.sql, and
		// createConnectorOperationRun via its db param (which also carries its
		// connector-version read into the same tx — safe, it is a read).
		const { claim, eventId } = await sql.begin(async (tx) => {
			// Serialize approval queueing against connection deletion: take a SHARE
			// lock on the connection row and re-verify it is still live. A delete's
			// tombstone+expiry tx holds FOR UPDATE on the same row, so an in-flight
			// delete blocks this tx until it commits, then this predicate sees the
			// tombstone and refuses — an approval can never commit into the gap
			// between a delete's expiry scan and its tombstone. (The runs
			// FK key-share lock alone would only serialize, not refuse.)
			const liveConnection = await tx`
				SELECT 1 FROM connections
				WHERE id = ${connection.id}
					AND organization_id = ${ctx.organizationId}
					AND deleted_at IS NULL
				FOR SHARE
			`;
			if (liveConnection.length === 0) {
				throw new ToolUserError(
					`Connection ${args.connection_id} was deleted while this operation was being queued.`,
					409,
				);
			}
			const createdRun = await createConnectorOperationRun({
				organizationId: ctx.organizationId,
				connectionId: connection.id,
				connectorKey: connection.connector_key,
				operationKey: operation.operation_key,
				operationInput: input,
				approvalMode,
				requireCompiledCode: operation.backend === "local_action",
				// Persist the TRUSTED principal so a queued run's policy is
				// re-evaluated at approve time against who queued it, not who
				// approves it (sol #5) — and in the SAME acting mode, so an
				// autonomous run's tighter autonomous rule isn't lost to an
				// attended recheck.
				policyPrincipalKind: actor.kind,
				policyPrincipalId: actor.id,
				createdByUserId: ctx.userId,
				watcherId: ctx.actingWatcherId,
				windowId: ctx.actingWindowId,
				idempotencyKey: args.idempotency_key,
				db: tx,
			});
			if (!createdRun.created) {
				return { claim: createdRun, eventId: null };
			}
			const createdRunId = createdRun.runId;
			const event = await insertEvent(
				{
				entityIds,
				organizationId: ctx.organizationId,
				originId: `run_${createdRunId}_pending`,
				title: `${operation.name} — pending approval`,
				content: `Agent requested operation: ${operation.name}`,
				semanticType: "operation",
				connectorKey: connection.connector_key,
				connectionId: args.connection_id,
				runId: createdRunId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInputSchema:
					(operation.input_schema as Record<string, unknown> | undefined) ??
					null,
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
					connection_name:
						connection.display_name ?? connection.connector_key,
					run_id: createdRunId,
					...currentMcpActivityEventMetadata(ctx),
				},
				authorName: ctx.clientId ?? "agent",
				clientId: ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null,
			},
				{ sql: tx },
			);
			return { claim: createdRun, eventId: Number(event.id) };
		});
		if (!claim.created) {
			await trackOperationReaction(claim.runId);
			return replayExistingOperationRun(claim, operation.name, ctx);
		}
		if (eventId == null) {
			throw new Error("Created approval action run has no approval event.");
		}
		const runId = claim.runId;

		// Telemetry + notification run AFTER the run+event are durably committed,
		// so they never reference a rolled-back run and stay off the hot path.
		await trackOperationReaction(runId);

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
			mcpActivity: currentMcpActivityAttribution(ctx),
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

	// Non-queued (device / inline) runs carry no approval event, so there is no
	// second write to bind atomically — create the run on the pool.
	const claim = await createConnectorOperationRun({
		organizationId: ctx.organizationId,
		connectionId: connection.id,
		connectorKey: connection.connector_key,
		operationKey: operation.operation_key,
		operationInput: input,
		approvalMode,
		requireCompiledCode: operation.backend === "local_action",
		policyPrincipalKind: actor.kind,
		policyPrincipalId: actor.id,
		createdByUserId: activation ? visibilityUserId : ctx.userId,
		watcherId: ctx.actingWatcherId,
		windowId: ctx.actingWindowId,
		idempotencyKey: args.idempotency_key,
		activation,
	});
	if (!claim.created) {
		await trackOperationReaction(claim.runId);
		return replayExistingOperationRun(claim, operation.name, ctx);
	}
	const runId = claim.runId;
	if (activation) {
		await trackOperationReaction(runId);
		return {
			action: "execute",
			run_id: runId,
			status: "in_progress",
			message: `Operation '${operation.name}' is waiting for an eligible page visit.`,
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
		await trackOperationReaction(runId);
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
		visibilityUserId,
		env,
		ctx.abortSignal,
	);
	await trackOperationReaction(runId);
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

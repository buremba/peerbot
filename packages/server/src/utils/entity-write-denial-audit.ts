import { retryWithBackoff } from "@lobu/core";
import type { ActingPrincipal } from "../authz/entity-policy";
import { currentMcpActivityEventMetadata } from "../lobu/stores/mcp-client-conversations";
import type { ToolContext } from "../tools/registry";
import { insertConnectionlessAuditEvent } from "./insert-event";
import logger from "./logger";

export type EntityWriteDenialOperation = "create" | "delete";

export interface EntityWritePolicyDenialAudit {
	ctx: ToolContext;
	attemptId: string;
	operation: EntityWriteDenialOperation;
	reason: string;
	entityId: number | null;
	entityType: string;
	entityOrganizationId: string | null;
	actor: ActingPrincipal;
	automationId: number | null;
}

const LOAD_BEARING_AUDIT_RETRY = {
	maxRetries: 1,
	baseDelay: 500,
} as const;

/**
 * Persist the append-only policy-denial row before manage_entity returns its
 * 403. This write is deliberately load-bearing: if the audit cannot commit,
 * the caller receives an operational failure and the guarded mutation remains
 * unreachable.
 */
export async function persistEntityWritePolicyDenial(
	params: EntityWritePolicyDenialAudit,
): Promise<void> {
	const {
		ctx,
		attemptId,
		operation,
		reason,
		entityId,
		entityType,
		entityOrganizationId,
		actor,
		automationId,
	} = params;
	const sameOrgEntityIds =
		entityId !== null && entityOrganizationId === ctx.organizationId
			? [entityId]
			: [];
	const originId = `entity_write_denial:v1:${attemptId}:${operation}`;

	try {
		await retryWithBackoff(
			() =>
				insertConnectionlessAuditEvent(
					{
						entityIds: sameOrgEntityIds,
						organizationId: ctx.organizationId,
						originId,
						title: `Entity ${operation} denied by policy`,
						payloadType: "empty",
						semanticType: "change",
						originType: "entity_write_denial",
						metadata: {
							category: "entity_write_denial",
							denial_source: "policy",
							operation,
							reason,
							denied_fields: [],
							entity_id: entityId,
							entity_type: entityType,
							principal_kind: actor.kind,
							principal_id: actor.id,
							automation_id: automationId,
							run_id: ctx.actingRunId ?? null,
							tool_call_id_or_equivalent: attemptId,
							...currentMcpActivityEventMetadata(ctx),
						},
						createdBy: ctx.userId,
						clientId: ctx.clientId ?? null,
						automationId,
						runId: ctx.actingRunId ?? null,
					},
					{ subject: "entity", op: "denied" },
				),
			LOAD_BEARING_AUDIT_RETRY,
		);
	} catch (err) {
		logger.error(
			{
				err,
				organizationId: ctx.organizationId,
				attemptId,
				operation,
				denialSource: "policy",
				reason,
				entityId,
				entityType,
				principalKind: actor.kind,
				principalId: actor.id,
				automationId,
				runId: ctx.actingRunId ?? null,
			},
			"[entity-write-denial] load-bearing denial audit failed; entity mutation remains blocked",
		);
		throw new Error(
			"Entity write was blocked, but its denial audit could not be persisted",
			{ cause: err },
		);
	}
}

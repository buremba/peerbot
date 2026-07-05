/**
 * Deployments API — the config audit trail behind the owletto
 * Infrastructure → Deployments tab.
 *
 * A "deployment" is one `lobu apply` run: the CLI threads an
 * `x-lobu-apply-id` header through every mutation (grouping the
 * `metadata.category='config'` events those handlers emit) and POSTs a
 * summary here at the end, stored as a `metadata.category='deployment'`
 * event. Standalone config changes (web UI / API edits, no apply_id) appear
 * in the same feed as ungrouped rows.
 *
 * All rows are append-only and never superseded, so reads go to `events`
 * directly rather than the `current_event_records` view (same rationale as
 * the guardrail-trips feed: the view would force an `event_embeddings`
 * join). Org-scoped + Postgres-backed — correct under N replicas.
 */

import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import type { Env } from "../index";
import { getApplyContext, parseApplyId } from "../utils/apply-context";
import { insertEvent } from "../utils/insert-event";
import { requireSessionOrAdminPat } from "./agent-routes";
import { orgContext } from "./stores/org-context";

const routes = new Hono<{ Bindings: Env }>();

routes.use("*", mcpAuth);

routes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

const DEPLOYMENT_STATUSES = new Set(["succeeded", "partial_failure"]);

function clampLimit(raw: string | undefined, fallback: number, max: number) {
	const parsed = Number.parseInt(raw ?? String(fallback), 10);
	return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}

// ── Ingest a deployment summary (posted by `lobu apply`) ─────────────────────

routes.post("/", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const organizationId = c.get("organizationId") as string;

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	const applyId = parseApplyId(
		typeof body.apply_id === "string" ? body.apply_id : null,
	);
	if (!applyId) {
		return c.json({ error: "apply_id must match apl_<id>" }, 400);
	}
	const status = typeof body.status === "string" ? body.status : "";
	if (!DEPLOYMENT_STATUSES.has(status)) {
		return c.json(
			{ error: "status must be 'succeeded' or 'partial_failure'" },
			400,
		);
	}
	const manifestHash =
		typeof body.manifest_hash === "string" ? body.manifest_hash : null;
	const cliVersion =
		typeof body.cli_version === "string" ? body.cli_version : null;
	const gitSha = typeof body.git_sha === "string" ? body.git_sha : null;
	const gitDirty = typeof body.git_dirty === "boolean" ? body.git_dirty : null;
	const counts =
		body.counts && typeof body.counts === "object" ? body.counts : {};
	const countsByKind =
		body.counts_by_kind && typeof body.counts_by_kind === "object"
			? body.counts_by_kind
			: {};
	const errorText = typeof body.error === "string" ? body.error : null;

	const sql = getDb();
	// Retried POSTs (CLI network blip) must not create a second deployment row.
	const existing = await sql`
		SELECT id FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'deployment'
		  AND metadata->>'apply_id' = ${applyId}
		LIMIT 1
	`;
	if (existing.length > 0) {
		return c.json({ id: existing[0].id, deduped: true });
	}

	const applyCtx = getApplyContext(c);
	const countsSummary = counts as Record<string, unknown>;
	const title = `Deployment ${applyId.slice(4, 12)} — ${Number(countsSummary.create) || 0} created, ${Number(countsSummary.update) || 0} updated, ${Number(countsSummary.delete) || 0} deleted`;

	// Awaited (unlike the fire-and-forget config writers): the CLI warns the
	// operator when the summary can't be recorded, so surface the failure.
	const event = await insertEvent({
		entityIds: [],
		organizationId,
		originId: `deployment_${applyId}`,
		title,
		semanticType: "change",
		originType: "deployment",
		payloadType: "empty",
		payloadData: {
			counts_by_kind: countsByKind,
			...(errorText ? { error: errorText } : {}),
		},
		metadata: {
			category: "deployment",
			apply_id: applyId,
			status,
			manifest_hash: manifestHash,
			git_sha: gitSha,
			git_dirty: gitDirty,
			cli_version: cliVersion,
			counts,
		},
		createdBy: applyCtx.createdBy,
		clientId: applyCtx.clientId,
	});

	return c.json({ id: event.id }, 201);
});

// ── Feed: deployments + standalone config changes ────────────────────────────
//
// Keyset pagination on id DESC alone. For this append-only audit slice the
// event id (one global sequence, all replicas insert through the same PG) is
// the total order; a created_at cursor would be lossy — timestamps serialize
// to JSON at millisecond precision while Postgres stores microseconds, so
// same-millisecond rows get skipped on the next page. `payload_data` (the
// full state snapshots) is deliberately NOT selected — detail routes carry it.

routes.get("/", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const limit = clampLimit(c.req.query("limit"), 50, 100);
	const beforeId = Number.parseInt(c.req.query("before_id") ?? "", 10);
	const useCursor = Number.isFinite(beforeId);

	const sql = getDb();
	const rows = await sql`
		SELECT id, created_at, title, metadata, created_by
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND (
		    metadata->>'category' = 'deployment'
		    OR (metadata->>'category' = 'config' AND metadata->>'apply_id' IS NULL)
		  )
		  ${useCursor ? sql`AND id < ${beforeId}` : sql``}
		ORDER BY id DESC
		LIMIT ${limit + 1}
	`;

	const page = rows.slice(0, limit);
	const items = page.map((row) => {
		const metadata = (row.metadata ?? {}) as Record<string, unknown>;
		if (metadata.category === "deployment") {
			return {
				type: "deployment" as const,
				id: row.id,
				applyId: metadata.apply_id ?? null,
				createdAt: row.created_at,
				title: row.title,
				status: metadata.status ?? null,
				counts: metadata.counts ?? null,
				manifestHash: metadata.manifest_hash ?? null,
				gitSha: metadata.git_sha ?? null,
				gitDirty: metadata.git_dirty ?? null,
				cliVersion: metadata.cli_version ?? null,
				createdBy: row.created_by ?? null,
			};
		}
		return {
			type: "change" as const,
			id: row.id,
			createdAt: row.created_at,
			title: row.title,
			resourceKind: metadata.resource_kind ?? null,
			resourceId: metadata.resource_id ?? null,
			op: metadata.op ?? null,
			changedFields: metadata.changed_fields ?? null,
			actorSource: metadata.actor_source ?? null,
			createdBy: row.created_by ?? null,
		};
	});

	return c.json({ items, has_more: rows.length > limit });
});

// ── Shared before/after computation ──────────────────────────────────────────
//
// `before` for each config event is the previous config event for the same
// (resource_kind, resource_id) — the event-sourced fold, one step deep. The
// LATERAL rides the config-changes partial index (org, created_at, id).

async function fetchChangesWithBefore(
	organizationId: string,
	filter: { applyId?: string; eventId?: number },
) {
	const sql = getDb();
	return sql`
		SELECT
			e.id, e.created_at, e.title, e.metadata, e.payload_data, e.created_by,
			prev.payload_data AS before_payload
		FROM events e
		LEFT JOIN LATERAL (
			SELECT p.payload_data
			FROM events p
			WHERE p.organization_id = e.organization_id
			  AND p.semantic_type = 'change'
			  AND p.metadata->>'category' = 'config'
			  AND p.metadata->>'resource_kind' = e.metadata->>'resource_kind'
			  AND p.metadata->>'resource_id' = e.metadata->>'resource_id'
			  AND p.id < e.id
			ORDER BY p.id DESC
			LIMIT 1
		) prev ON true
		WHERE e.organization_id = ${organizationId}
		  AND e.semantic_type = 'change'
		  AND e.metadata->>'category' = 'config'
		  ${
				filter.applyId !== undefined
					? sql`AND e.metadata->>'apply_id' = ${filter.applyId}`
					: sql`AND e.id = ${filter.eventId as number}`
			}
		ORDER BY e.id ASC
	`;
}

function toChangeDetail(row: Record<string, any>) {
	const metadata = (row.metadata ?? {}) as Record<string, unknown>;
	const payload = (row.payload_data ?? {}) as Record<string, unknown>;
	const beforePayload = (row.before_payload ?? null) as Record<
		string,
		unknown
	> | null;
	return {
		id: row.id,
		createdAt: row.created_at,
		title: row.title,
		resourceKind: metadata.resource_kind ?? null,
		resourceId: metadata.resource_id ?? null,
		op: metadata.op ?? null,
		changedFields: metadata.changed_fields ?? null,
		actorSource: metadata.actor_source ?? null,
		applyId: metadata.apply_id ?? null,
		createdBy: row.created_by ?? null,
		before: beforePayload?.state ?? null,
		after: payload.state ?? null,
	};
}

// ── Standalone-change detail ─────────────────────────────────────────────────
// Registered before `/:applyId` so the literal segment wins the match.

routes.get("/changes/:eventId", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const eventId = Number.parseInt(c.req.param("eventId"), 10);
	if (!Number.isFinite(eventId)) {
		return c.json({ error: "eventId must be a number" }, 400);
	}

	const rows = await fetchChangesWithBefore(organizationId, { eventId });
	if (rows.length === 0) return c.json({ error: "Change not found" }, 404);
	return c.json({ change: toChangeDetail(rows[0]) });
});

// ── Deployment detail ────────────────────────────────────────────────────────

routes.get("/:applyId", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const applyId = parseApplyId(c.req.param("applyId"));
	if (!applyId) return c.json({ error: "Invalid apply id" }, 400);

	const sql = getDb();
	const summaryRows = await sql`
		SELECT id, created_at, title, metadata, payload_data, created_by
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'deployment'
		  AND metadata->>'apply_id' = ${applyId}
		LIMIT 1
	`;
	if (summaryRows.length === 0) {
		return c.json({ error: "Deployment not found" }, 404);
	}
	const summary = summaryRows[0];
	const summaryMeta = (summary.metadata ?? {}) as Record<string, unknown>;
	const summaryPayload = (summary.payload_data ?? {}) as Record<
		string,
		unknown
	>;

	const changeRows = await fetchChangesWithBefore(organizationId, { applyId });

	return c.json({
		deployment: {
			id: summary.id,
			applyId,
			createdAt: summary.created_at,
			title: summary.title,
			status: summaryMeta.status ?? null,
			counts: summaryMeta.counts ?? null,
			countsByKind: summaryPayload.counts_by_kind ?? null,
			error: summaryPayload.error ?? null,
			manifestHash: summaryMeta.manifest_hash ?? null,
			gitSha: summaryMeta.git_sha ?? null,
			gitDirty: summaryMeta.git_dirty ?? null,
			cliVersion: summaryMeta.cli_version ?? null,
			createdBy: summary.created_by ?? null,
		},
		changes: changeRows.map(toChangeDetail),
	});
});

export { routes as deploymentRoutes };

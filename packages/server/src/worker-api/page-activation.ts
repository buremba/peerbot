import type {
	ActivatePageRequest,
	ActivatePageResponse,
} from "@lobu/core/contracts/worker/protocol";
import type { Context } from "hono";
import { getDb, pgTextArray } from "../db/client";
import type { Env } from "../index";
import { normalizePageActivationUrl } from "../runs/page-activation";

export async function activatePageRun(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	if (c.var.workerAuthMode !== "user" || !c.var.workerUserId) {
		return c.json({ error: "User-scoped worker token required" }, 403);
	}

	let body: ActivatePageRequest;
	try {
		body = await c.req.json<ActivatePageRequest>();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	if (
		!body.worker_id ||
		!Number.isSafeInteger(body.run_id) ||
		body.run_id < 1 ||
		!Number.isSafeInteger(body.tab_id) ||
		body.tab_id < 0
	) {
		return c.json({ error: "Invalid page activation request" }, 400);
	}
	const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
	if (boundWorkerId && boundWorkerId !== body.worker_id) {
		return c.json({ error: "worker_id_mismatch" }, 403);
	}

	let normalizedUrl: string;
	try {
		normalizedUrl = normalizePageActivationUrl(body.url);
	} catch {
		return c.json({ error: "Invalid page activation URL" }, 400);
	}

	const sql = getDb();
	const devices = await sql<{ id: string }>`
		SELECT id
		FROM device_workers
		WHERE user_id = ${c.var.workerUserId}
		  AND worker_id = ${body.worker_id}
		  AND platform = 'chrome-extension'
		LIMIT 1
	`;
	const deviceId = devices[0]?.id;
	if (!deviceId) return c.json({ error: "Chrome worker not registered" }, 403);

	const orgIds = c.var.workerOrgIds ?? [];
	if (orgIds.length === 0) {
		return c.json<ActivatePageResponse>({ status: "unavailable" });
	}
	const updated = await sql<{ id: number }>`
		UPDATE runs
		SET activated_at = current_timestamp,
		    activated_by_device_worker_id = ${deviceId},
		    activation_tab_id = ${body.tab_id}
		WHERE id = ${body.run_id}
		  AND organization_id = ANY(${pgTextArray(orgIds)}::text[])
		  AND created_by_user_id = ${c.var.workerUserId}
		  AND run_type = 'action'
		  AND status = 'pending'
		  AND approval_status = 'auto'
		  AND activation_kind = 'page_visit'
		  AND activated_at IS NULL
		  AND expires_at > current_timestamp
		  AND ${normalizedUrl} = ANY(activation_target_urls)
		RETURNING id
	`;
	return c.json<ActivatePageResponse>({
		status: updated.length === 1 ? "activated" : "unavailable",
	});
}

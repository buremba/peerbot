/**
 * Workspace attention feed — shared by manage_operations.list_activity,
 * Home UI, and first-turn agent ephemeral context.
 *
 * Multi-replica safe: pure SQL reads + deterministic collapse (no in-memory
 * shared state).
 */

import { getDb, pgTextArray } from "../../../db/client";
import { listNotifications } from "../../../notifications/service";
import { buildResourcePermalink } from "../../../utils/url-builder";
import { ENTITY_CHANGE_ACTION_KEYS } from "../entity-field-approval";

const USER_FACING_RUN_TYPES = ["behavior", "sync", "action", "internal"] as const;

export type ActivityCard = {
	id: string;
	kind: string;
	title: string;
	body: string | null;
	at: string;
	status: string | null;
	count: number;
	href: string | null;
	unread?: boolean;
	notification_id?: number;
	run_id?: number;
	/**
	 * Kind of pending interaction behind this notification (events
	 * `interaction_type` vocabulary — 'approval' today). Clients pick the UI
	 * for the type; new interaction kinds extend this value, not the card shape.
	 */
	interaction_type?: string;
	/**
	 * LIVE interaction state, resolved from the interaction's authoritative
	 * per-type source — for 'approval' that is runs.approval_status
	 * ('pending' | 'approved' | 'rejected'), NOT the proposal event's own
	 * interaction_status, which stays 'pending' forever because the events
	 * chain supersedes instead of mutating. A decided interaction therefore
	 * stops rendering as actionable everywhere.
	 */
	interaction_status?: string;
	/**
	 * Server-side policy: this interaction can be completed inline from the
	 * feed. For 'approval': the action_key has a known-safe one-click web
	 * executor (entity change kinds); other kinds keep their review-page CTA.
	 */
	interaction_inline?: boolean;
	member_run_ids?: number[];
	connection_id?: number;
	behavior_id?: number;
};

type RawCard = ActivityCard & {
	collapseKey: string | null;
	itemsCollected: number | null;
	atMs: number;
};

function isFailedStatus(status: string | null | undefined): boolean {
	return (
		status === "failed" || status === "timeout" || status === "error"
	);
}

function resolveNotifHref(
	ownerSlug: string,
	n: {
		type?: unknown;
		resource_url?: unknown;
		resource_id?: unknown;
	},
): string | null {
	const explicit =
		typeof n.resource_url === "string" ? n.resource_url.trim() : "";
	if (explicit) {
		// Invitation: never land on /members
		if (
			n.type === "invitation_received" &&
			(explicit.endsWith("/members") || explicit.includes("/members?"))
		) {
			const id =
				typeof n.resource_id === "string" ? n.resource_id.trim() : "";
			if (id) {
				return `/auth/accept-invitation?invitationId=${encodeURIComponent(id)}`;
			}
		}
		// Weak dumps for auth types → connectors index
		if (
			(n.type === "browser_auth_expired" ||
				n.type === "connection_permission_request") &&
			(explicit.endsWith("/infrastructure") ||
				explicit.endsWith("/connectors") ||
				explicit.endsWith("/connectors/"))
		) {
			// Keep explicit if it already has connector/id depth
			if (!/\/connectors\/[^/]+\/\d+/.test(explicit)) {
				return `/${ownerSlug}/connectors`;
			}
		}
		return explicit;
	}
	if (n.type === "invitation_received" && typeof n.resource_id === "string") {
		return `/auth/accept-invitation?invitationId=${encodeURIComponent(n.resource_id.trim())}`;
	}
	if (
		n.type === "connection_permission_request" ||
		n.type === "browser_auth_expired"
	) {
		return `/${ownerSlug}/connectors`;
	}
	return `/${ownerSlug}/memory`;
}

export function runHref(
	ownerSlug: string,
	row: {
		id: number;
		run_type: string;
		watcher_id: number | null;
		connection_id: number | null;
		connector_key: string | null;
		approval_status: string | null;
		agent_id: string | null;
	},
): string | null {
	if (row.run_type === "behavior" && row.watcher_id != null && row.agent_id) {
		return `/${ownerSlug}/agents/${row.agent_id}/behaviors/${row.watcher_id}`;
	}
	if (
		(row.run_type === "sync" || row.run_type === "action") &&
		row.connection_id != null &&
		row.connector_key
	) {
		if (
			row.run_type === "action" &&
			(row.approval_status === "pending" ||
				row.approval_status === "pending_approval")
		) {
			return (
				buildResourcePermalink(ownerSlug, {
					kind: "run",
					runId: row.id,
				}) ?? null
			);
		}
		return `/${ownerSlug}/connectors/${row.connector_key}/${row.connection_id}`;
	}
	return (
		buildResourcePermalink(ownerSlug, { kind: "run", runId: row.id }) ?? null
	);
}

function runTitle(row: {
	run_type: string;
	watcher_name: string | null;
	watcher_id: number | null;
	feed_display_name: string | null;
	feed_key: string | null;
	connection_display_name: string | null;
	operation_key: string | null;
	connector_key: string | null;
	id: number;
}): string {
	if (row.run_type === "behavior") {
		return (
			row.watcher_name ??
			(row.watcher_id != null
				? `Behavior #${row.watcher_id}`
				: `Run #${row.id}`)
		);
	}
	if (row.run_type === "sync") {
		return (
			row.feed_display_name ??
			row.feed_key ??
			row.connection_display_name ??
			`Feed sync #${row.id}`
		);
	}
	if (row.operation_key) {
		const last = row.operation_key.includes(".")
			? (row.operation_key.split(".").pop() ?? row.operation_key)
			: row.operation_key;
		const pretty = last.replace(/[_-]+/g, " ");
		return row.connection_display_name
			? `${pretty} · ${row.connection_display_name}`
			: pretty;
	}
	return (
		row.connection_display_name ??
		row.connector_key ??
		`Run #${row.id}`
	);
}

function collapseKeyForRun(row: {
	run_type: string;
	connection_id: number | null;
	watcher_id: number | null;
	connector_key: string | null;
	feed_id: number | null;
}): string | null {
	if (row.run_type === "sync" || row.run_type === "action") {
		if (row.connection_id != null) return `conn:${row.connection_id}`;
		if (row.connector_key && row.feed_id != null) {
			return `feed:${row.connector_key}:${row.feed_id}`;
		}
		return null;
	}
	if (row.run_type === "behavior" && row.watcher_id != null) {
		return `watcher:${row.watcher_id}`;
	}
	return null;
}

/** Adjacent collapse — same rules as Owletto client (oldest→newest input). */
export function collapseAdjacentActivityCards(items: RawCard[]): RawCard[] {
	if (items.length <= 1) return items;
	const out: RawCard[] = [];
	let i = 0;
	while (i < items.length) {
		const head = items[i]!;
		if (
			head.kind === "notification" ||
			!head.collapseKey ||
			!head.status ||
			isFailedStatus(head.status)
		) {
			out.push(head);
			i += 1;
			continue;
		}
		let j = i + 1;
		let itemsSum =
			typeof head.itemsCollected === "number" ? head.itemsCollected : null;
		const memberIds = head.run_id != null ? [head.run_id] : [];
		while (j < items.length) {
			const next = items[j]!;
			if (
				next.kind === "notification" ||
				next.collapseKey !== head.collapseKey ||
				next.status !== head.status ||
				isFailedStatus(next.status)
			) {
				break;
			}
			if (typeof next.itemsCollected === "number") {
				itemsSum = (itemsSum ?? 0) + next.itemsCollected;
			} else if (itemsSum != null) {
				itemsSum = null;
			}
			if (next.run_id != null) memberIds.push(next.run_id);
			j += 1;
		}
		const count = j - i;
		if (count === 1) {
			out.push(head);
		} else {
			const latest = items[j - 1]!;
			const status = latest.status ?? "run";
			const body =
				itemsSum != null
					? `${count}× ${status} · ${itemsSum} items total`
					: `${count}× ${status}`;
			out.push({
				...latest,
				id: `group:${head.collapseKey}:${latest.id}`,
				kind:
					latest.kind === "sync"
						? "sync_group"
						: latest.kind === "behavior_run"
							? "behavior_run_group"
							: `${latest.kind}_group`,
				body,
				count,
				member_run_ids: memberIds,
			});
		}
		i = j;
	}
	return out;
}

export async function listOrgActivity(opts: {
	organizationId: string;
	userId: string | null;
	ownerSlug: string;
	limit?: number;
	includeNotifications?: boolean;
	includeRuns?: boolean;
	aggregate?: boolean;
	kinds?: string[];
	/**
	 * Scope to one agent: filter runs to that agent's Behaviors and drop
	 * notifications (org/user-scoped, not attributable to an agent).
	 */
	agentId?: string;
}): Promise<{ items: ActivityCard[]; total: number; limit: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 24, 1), 50);
	// Notifications are not agent-attributable, so an agent-scoped feed omits
	// them entirely and shows only that agent's runs.
	const includeNotifications =
		opts.includeNotifications !== false && !!opts.userId && !opts.agentId;
	const includeRuns = opts.includeRuns !== false;
	const aggregate = opts.aggregate !== false;
	const kindFilter = opts.kinds?.length ? new Set(opts.kinds) : null;

	const raw: RawCard[] = [];

	if (includeNotifications && opts.userId) {
		if (!kindFilter || kindFilter.has("notification")) {
			const { notifications } = await listNotifications({
				organizationId: opts.organizationId,
				userId: opts.userId,
				// Match the run window (60) so notifications can survive the
				// merge into the final chronological slice even at limit: 50.
				limit: 60,
			});
			for (const n of notifications) {
				const type = String(n.type ?? "generic");
				const created = String(n.created_at ?? new Date().toISOString());
				const atMs = new Date(created).getTime();
				const approvalRunId =
					n.approval_run_id != null ? Number(n.approval_run_id) : NaN;
				const interactionType =
					typeof n.interaction_type === "string" && n.interaction_type !== ""
						? n.interaction_type
						: undefined;
				// Per-type live-state resolution: 'approval' reads the run's state
				// machine. A future interaction kind plugs its own source in here —
				// the card contract (interaction_*) does not change.
				const interactionStatus =
					interactionType === "approval" &&
					typeof n.approval_status === "string" &&
					n.approval_status !== ""
						? n.approval_status
						: undefined;
				const interactionInline =
					interactionType === "approval" &&
					interactionStatus != null &&
					(ENTITY_CHANGE_ACTION_KEYS as readonly string[]).includes(
						String(n.approval_action_key ?? ""),
					);
				raw.push({
					id: `n:${n.id}`,
					kind: "notification",
					title: String(n.title ?? "Notification"),
					body: n.body != null ? String(n.body) : null,
					at: created,
					atMs: Number.isFinite(atMs) ? atMs : 0,
					status: type,
					count: 1,
					href: resolveNotifHref(opts.ownerSlug, n),
					unread: n.is_read === false || n.is_read === "f",
					notification_id: Number(n.id),
					run_id: Number.isFinite(approvalRunId) ? approvalRunId : undefined,
					interaction_type: interactionStatus != null ? interactionType : undefined,
					interaction_status: interactionStatus,
					interaction_inline: interactionInline || undefined,
					collapseKey: null,
					itemsCollected: null,
				});
			}
		}
	}

	if (includeRuns) {
		const runKinds = kindFilter
			? USER_FACING_RUN_TYPES.filter((k) => kindFilter.has(k) || kindFilter.has("run"))
			: [...USER_FACING_RUN_TYPES];
		if (runKinds.length > 0) {
			const sql = getDb();
			// When agent-scoped, restrict to that agent's Behavior runs. The join to
			// `watchers` already exposes `w.agent_id`; a non-null agentId turns the
			// LEFT JOIN into an effective inner filter (runs with no watcher, i.e.
			// bare syncs/actions, are dropped — they aren't agent-owned).
			const agentFilter = opts.agentId
				? sql`AND w.agent_id = ${opts.agentId}`
				: sql``;
			const rows = (await sql`
        SELECT r.id, r.run_type, r.watcher_id, r.connection_id, r.feed_id,
               r.connector_key, r.action_key AS operation_key,
               r.approval_status, r.status, r.error_message, r.items_collected,
               r.created_at, r.completed_at,
               f.feed_key, f.display_name AS feed_display_name,
               c.display_name AS connection_display_name,
               w.name AS watcher_name, w.agent_id
        FROM runs r
        LEFT JOIN feeds f ON f.id = r.feed_id
        LEFT JOIN connections c ON c.id = r.connection_id
        LEFT JOIN watchers w ON w.id = r.watcher_id
        WHERE r.organization_id = ${opts.organizationId}
          AND r.run_type = ANY(${pgTextArray(runKinds)}::text[])
          ${agentFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 60
      `) as unknown as Array<{
				id: number;
				run_type: string;
				watcher_id: number | null;
				connection_id: number | null;
				feed_id: number | null;
				connector_key: string | null;
				operation_key: string | null;
				approval_status: string | null;
				status: string;
				error_message: string | null;
				items_collected: number | null;
				created_at: string | Date;
				feed_key: string | null;
				feed_display_name: string | null;
				connection_display_name: string | null;
				watcher_name: string | null;
				agent_id: string | null;
			}>;

			for (const r of rows) {
				const created =
					r.created_at instanceof Date
						? r.created_at.toISOString()
						: String(r.created_at);
				const atMs = new Date(created).getTime();
				const kind =
					r.run_type === "behavior"
						? "behavior_run"
						: r.run_type === "sync"
							? "sync"
							: "run";
				const body = r.error_message
					? r.error_message.slice(0, 120)
					: r.items_collected != null
						? `${r.status} · ${r.items_collected} items`
						: r.status;
				raw.push({
					id: `r:${r.id}`,
					kind,
					title: runTitle(r),
					body,
					at: created,
					atMs: Number.isFinite(atMs) ? atMs : 0,
					status: r.status,
					count: 1,
					href: runHref(opts.ownerSlug, r),
					run_id: r.id,
					connection_id: r.connection_id ?? undefined,
					behavior_id: r.watcher_id ?? undefined,
					collapseKey: collapseKeyForRun(r),
					itemsCollected: r.items_collected,
				});
			}
		}
	}

	// Newest window → chronological → optional adjacent collapse → cap.
	raw.sort((a, b) => b.atMs - a.atMs);
	const windowed = raw.slice(0, 60);
	windowed.reverse();
	const collapsed = aggregate
		? collapseAdjacentActivityCards(windowed)
		: windowed;
	const items = collapsed.slice(-limit).map(({ collapseKey, itemsCollected, atMs, ...card }) => card);

	return { items, total: items.length, limit };
}

/** Drop the query string + fragment from a deep-link (absolute or relative).
 * Notification hrefs can carry OAuth authorization codes and invitation ids as
 * query params; those must never reach worker context. Kept out of the UI path
 * on purpose: listOrgActivity still returns full hrefs for the trusted client. */
function stripUrlParams(url: string): string {
	const cut = url.search(/[?#]/);
	return cut >= 0 ? url.slice(0, cut) : url;
}

/** Redact query strings from any URL embedded in free-form body text, so a
 * notification body like "re-auth here: https://…?code=…" cannot smuggle a
 * credential into worker context. */
function redactBodyUrls(text: string): string {
	return text.replace(/(https?:\/\/[^\s?#]+)[^\s]*/g, "$1");
}

/**
 * Compact prompt block for first-turn agent context (≤ ~2k chars).
 *
 * This feeds worker `ephemeralContext`, an untrusted-prompt surface, so it
 * emits an allowlisted, worker-safe projection only: query params are stripped
 * from links and body URLs (OAuth codes, invitation ids), and titles, errors,
 * and names are forwarded solely as sanitized untrusted text.
 */
export function formatActivityAttentionBlock(
	items: ActivityCard[],
	maxLines = 10,
): string {
	if (items.length === 0) return "";
	const lines: string[] = ["## Workspace attention (recent)"];
	const slice = items.slice(-maxLines);
	for (const it of slice) {
		const status = it.status ? ` [${it.status}]` : "";
		const count = it.count > 1 ? ` ×${it.count}` : "";
		const body = it.body
			? ` — ${redactBodyUrls(it.body).replace(/\s+/g, " ").slice(0, 120)}`
			: "";
		const href = it.href ? ` (${stripUrlParams(it.href)})` : "";
		let line = `- ${it.title}${count}${status}${body}${href}`;
		// Sanitize control chars like buildRunContextBlock
		line = [...line]
			.map((ch) => {
				const code = ch.codePointAt(0) ?? 0;
				return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
			})
			.join("")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 280);
		if (line.length > 2) lines.push(line);
	}
	const block = lines.join("\n");
	return block.length > 2000 ? block.slice(0, 2000) : block;
}

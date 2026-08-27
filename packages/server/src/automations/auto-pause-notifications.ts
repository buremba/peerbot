import { getDb } from "../db/client";
import { emit } from "../events/emitter";
import { createNotificationForUsers } from "../notifications/service";
import logger from "../utils/logger";
import { buildAutomationUrl } from "../utils/url-builder";

interface PausedAutomationNotificationRow {
	id: number;
	name: string | null;
	organization_id: string;
	organization_slug: string;
	consecutive_scheduled_failures: number;
	schedule_auto_paused_at: Date | string;
	admin_user_ids: string[];
}

export function automationAutoPauseNotificationKey(
	automationId: number,
	pausedAt: Date | string,
): string {
	return `automation:schedule-auto-paused:${automationId}:${new Date(pausedAt).getTime()}`;
}

/**
 * Deliver durable admin notifications for newly auto-paused Automations.
 *
 * The notification event is the completion marker. A failed insert remains
 * absent and is retried next tick; concurrent ticks collapse on the existing
 * events idempotency index. Rows without an admin/owner are excluded from the
 * bounded window so they cannot starve later, deliverable pauses.
 */
export async function runAutomationAutoPauseNotificationSweep(
	opts: { limit?: number } = {},
): Promise<{
	scanned: number;
	attempted: number;
	created: number;
	errors: number;
}> {
	const sql = getDb();
	const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
	const rows = await sql<PausedAutomationNotificationRow>`
    SELECT
      a.id,
      a.name,
      a.organization_id,
      o.slug AS organization_slug,
      a.consecutive_scheduled_failures,
      a.schedule_auto_paused_at,
      to_jsonb(array_agg(DISTINCT m."userId" ORDER BY m."userId")) AS admin_user_ids
    FROM automations a
    JOIN "organization" o ON o.id = a.organization_id
    JOIN "member" m
      ON m."organizationId" = a.organization_id
     AND m.role IN ('admin', 'owner')
    WHERE a.schedule_auto_paused_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM events e
        WHERE e.organization_id = a.organization_id
          AND e.metadata ? '_lobu_idempotency_key'
          AND e.metadata->>'_lobu_idempotency_key' =
            'automation:schedule-auto-paused:' || a.id::text || ':' ||
            floor(extract(epoch FROM a.schedule_auto_paused_at) * 1000)::bigint::text
      )
    GROUP BY a.id, a.name, a.organization_id, o.slug,
             a.consecutive_scheduled_failures, a.schedule_auto_paused_at
    ORDER BY a.schedule_auto_paused_at ASC, a.id ASC
    LIMIT ${limit}
  `;

	let attempted = 0;
	let created = 0;
	let errors = 0;
	for (const row of rows) {
		attempted++;
		try {
			const result = await createNotificationForUsers(row.admin_user_ids, {
				organizationId: row.organization_id,
				type: "generic",
				title: `Automation "${row.name ?? row.id}" was auto-paused`,
				body:
					`Lobu paused this schedule after ${row.consecutive_scheduled_failures} ` +
					"consecutive execution failures. Review the latest run, then complete " +
					"a successful manual run or change the cadence to resume it.",
				resourceType: "automation",
				resourceId: String(row.id),
				resourceUrl: buildAutomationUrl(row.organization_slug, row.id),
				idempotencyKey: automationAutoPauseNotificationKey(
					row.id,
					row.schedule_auto_paused_at,
				),
			});
			if (result.created) created++;
			emit(row.organization_id, {
				keys: ["notifications", "notifications-unread-count"],
			});
		} catch (error) {
			errors++;
			logger.warn(
				{ error, automationId: row.id },
				"[automations] Failed to deliver schedule auto-pause notification",
			);
		}
	}

	return { scanned: rows.length, attempted, created, errors };
}

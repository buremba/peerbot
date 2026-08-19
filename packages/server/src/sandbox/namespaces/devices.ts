/**
 * ClientSDK `devices` namespace.
 *
 * Lets a script find the caller's own registered devices — most importantly the
 * `id`, which is the value `automations.device_worker_id` and
 * `connections.device_worker_id` take when pinning work to a machine. Without
 * it an agent could pin a device but never discover one, and had to recover the
 * id from whatever already referenced it.
 *
 * A read-only wrapper over `queryDeviceWorkers`, the same function behind
 * `GET /api/me/devices` — one query, two transports, so the shapes cannot drift.
 */

import type { ToolContext } from "../../tools/registry";
import {
	type DeviceWorkerSummary,
	queryDeviceWorkers,
} from "../../worker-api/device-management";

export interface DevicesNamespace {
	/**
	 * The caller's registered devices, most-recently-seen first.
	 *
	 * Owner-scoped, not org-scoped: `device_workers` is keyed
	 * `(user_id, worker_id)` and its `organization_id` records where a device is
	 * attached, not who owns it. Devices attached to another workspace — or to
	 * none — are still the caller's and still listed.
	 */
	list(): Promise<DeviceWorkerSummary[]>;
}

export function buildDevicesNamespace(ctx: ToolContext): DevicesNamespace {
	return {
		async list() {
			// A system/service context carries no principal. Devices are owned by a
			// user, so there is no sensible "all devices" answer here — return none
			// rather than widen the query, which is the fail-closed direction.
			if (!ctx.userId) return [];
			return queryDeviceWorkers(ctx.userId);
		},
	};
}

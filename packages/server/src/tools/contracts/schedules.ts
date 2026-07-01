/**
 * Schedules capability contract.
 *
 * `actions: null` — manage_schedules keeps the fallback access rule (every
 * action is admin-tier because the tool is not read-only), exactly as before
 * the contract migration. Give it per-action tiers here when member-facing
 * schedule reads/writes are introduced. No SDK projection yet (client.schedules
 * is planned; adding `sdkNamespace` + `sdkMethods` here is all it will take).
 *
 * ⚠️ Pure module: zero value imports (see kernel.ts header for why).
 */

import { defineCapability } from "./kernel";

export const schedulesCapability = defineCapability({
	key: "schedules",
	tools: [
		{
			name: "manage_schedules",
			description:
				"Create / list / pause / cancel recurring or one-shot scheduled jobs. Supports send_notification and wake_agent action types. Per-row attribution lets you trace what scheduled it and from where.",
			actions: null,
		},
	],
});

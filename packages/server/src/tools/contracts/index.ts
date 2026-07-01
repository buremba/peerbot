/**
 * Capability-contract registry + derived policy slices.
 *
 * ⚠️ Pure module chain: this file and every `contracts/*.ts` it imports must
 * have zero value imports outside `contracts/` (see kernel.ts header).
 * `auth/tool-access.ts` and `sandbox/method-metadata.ts` value-import these
 * derived slices at module load.
 */

import {
	deriveActionTierTable,
	derivePublicReadTable,
	deriveSdkDocs,
} from "./kernel";
import { schedulesCapability } from "./schedules";
import { watchersCapability } from "./watchers";

export {
	buildContractNamespace,
	contractToolEntry,
	defineCapability,
} from "./kernel";
export type {
	ActionTier,
	CapabilityContract,
	MethodAccess,
	SdkMethodDocs,
	ToolContract,
} from "./kernel";
export { schedulesCapability } from "./schedules";
export { watchersCapability } from "./watchers";

/** Every migrated capability. Order defines derived METHOD_METADATA order. */
export const CAPABILITY_CONTRACTS = [
	watchersCapability,
	schedulesCapability,
] as const;

export const CONTRACT_MEMBER_WRITE_ACTIONS = deriveActionTierTable(
	CAPABILITY_CONTRACTS,
	"write",
);
export const CONTRACT_OWNER_ADMIN_ACTIONS = deriveActionTierTable(
	CAPABILITY_CONTRACTS,
	"admin",
);
export const CONTRACT_PUBLIC_READ_ACTIONS =
	derivePublicReadTable(CAPABILITY_CONTRACTS);
export const CONTRACT_SDK_DOCS = deriveSdkDocs(CAPABILITY_CONTRACTS);

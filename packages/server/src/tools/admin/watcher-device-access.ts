import type { DbClient } from '../../db/client';
import { ToolUserError } from '../../utils/errors';

/**
 * Ownership/access enforcement for pinning a watcher to a device worker
 * (`watchers.device_worker_id`). A device-worker watcher run spawns an agent
 * CLI on the *device owner's* machine, so an unvalidated pin lets a member-write
 * actor target another user's device — privilege escalation. This mirrors the
 * shape of watcher-execution-config.ts: a pure decision function (unit-tested)
 * plus a thin DB-backed assertion wrapper, both raising ToolUserError on reject.
 */

/** Minimal caller identity needed to authorize a device-worker pin. */
export interface DeviceWorkerAccessCaller {
  memberRole: string | null;
  userId: string | null;
  organizationId: string;
  isAuthenticated: boolean;
}

/** The device_workers fields that drive the access decision. */
export interface DeviceWorkerOwnershipRow {
  id: string;
  user_id: string | null;
  organization_id: string | null;
}

/**
 * Pure access decision (no DB). Returns null when the caller may pin `device`,
 * or a human-readable rejection reason otherwise. `device` is null when no
 * matching device_workers row exists.
 *
 * Rules:
 *  - System/internal callers (apply, automation, default-provisioning) carry no
 *    memberRole/userId yet are authenticated; they bypass action-access
 *    enforcement elsewhere, so don't block them here either.
 *  - The caller owns the device (`device.user_id === caller.userId`), OR
 *  - The caller is org owner/admin and the device is attached to the caller's
 *    org (`device.organization_id === caller.organizationId`).
 */
export function evaluateDeviceWorkerAccess(
  device: DeviceWorkerOwnershipRow | null,
  caller: DeviceWorkerAccessCaller
): string | null {
  const isSystem =
    caller.isAuthenticated && caller.userId === null && caller.memberRole === null;
  if (isSystem) return null;

  if (!device) {
    return `Device worker not found or not accessible.`;
  }

  // Owner of the device may always pin it.
  if (caller.userId !== null && device.user_id === caller.userId) {
    return null;
  }

  // Org owner/admin may pin any device attached to their org.
  const isOwnerOrAdmin = caller.memberRole === 'owner' || caller.memberRole === 'admin';
  if (
    isOwnerOrAdmin &&
    device.organization_id !== null &&
    device.organization_id === caller.organizationId
  ) {
    return null;
  }

  return `You can only pin a watcher to a device you own (or, as an org owner/admin, a device attached to your workspace).`;
}

/**
 * DB-backed assertion. `undefined`/`null` device_worker_id = no pin / clearing
 * the pin — both pass without a lookup. Otherwise the device_workers row is
 * resolved and run through evaluateDeviceWorkerAccess; a rejection throws
 * ToolUserError (403).
 */
export async function assertDeviceWorkerAccess(
  sql: DbClient,
  deviceWorkerId: string | null | undefined,
  caller: DeviceWorkerAccessCaller
): Promise<void> {
  if (deviceWorkerId === undefined || deviceWorkerId === null) return;
  const trimmed = deviceWorkerId.trim();
  if (!trimmed) return;

  const rows = (await sql`
    SELECT id, user_id, organization_id
    FROM device_workers
    WHERE id = ${trimmed}::uuid
    LIMIT 1
  `) as unknown as DeviceWorkerOwnershipRow[];

  const reason = evaluateDeviceWorkerAccess(rows[0] ?? null, caller);
  if (reason) {
    throw new ToolUserError(reason, 403);
  }
}

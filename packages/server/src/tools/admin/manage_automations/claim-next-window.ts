import {
  addAutomationPeriod,
  alignToAutomationWindowStart,
  inferAutomationGranularityFromSchedule,
  isAutomationTimeGranularity,
  type AutomationTimeGranularity,
} from '@lobu/connector-sdk';
import type { AutomationClaimNextWindowResult } from '@lobu/core/contracts/tools/manage-automations';
import type { DbClient } from '../../../db/client';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import {
  claimPendingAutomationRun,
  createAutomationRunInTransaction,
} from '../../../runs/queue-service';
import { classifyRunOutcome } from '../../../runs/run-outcome';
import { ToolUserError } from '../../../utils/errors';
import { ensureExpectedAutomationWindowStart } from '../../../utils/window-utils';
import { handleAutomationMode } from '../../get_content/automation-mode';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs } from '../manage_automations';

const DEFAULT_LEASE_SECONDS = 900;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 3600;

export function encodeExternalAutomationClaimOwner(ctx: ToolContext): string {
  const identity = {
    user_id: ctx.userId ?? null,
    agent_id: ctx.agentId ?? null,
    client_id: ctx.clientId ?? null,
    mcp_session_id: ctx.mcpSessionId ?? null,
  };
  if (Object.values(identity).every((value) => value == null)) {
    throw new ToolUserError(
      'claim_next_window requires an identified caller to own the window lease.',
      403
    );
  }
  return `external:${JSON.stringify(identity)}`;
}

export function isExternalAutomationClaimOwner(value: string): boolean {
  if (!value.startsWith('external:')) return false;
  try {
    const identity = JSON.parse(value.slice('external:'.length)) as unknown;
    if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) {
      return false;
    }
    const record = identity as Record<string, unknown>;
    const keys = ['user_id', 'agent_id', 'client_id', 'mcp_session_id'];
    if (
      Object.keys(record).length !== keys.length ||
      !keys.every(
        (key) =>
          Object.hasOwn(record, key) &&
          (record[key] == null || typeof record[key] === 'string')
      )
    ) {
      return false;
    }
    return keys.some((key) => record[key] != null);
  } catch {
    return false;
  }
}

export async function handleClaimNextWindow(
  args: ManageAutomationsArgs,
  env: Env,
  ctx: ToolContext
): Promise<AutomationClaimNextWindowResult> {
  const automationId = Number(args.automation_id);
  if (!Number.isSafeInteger(automationId) || automationId < 1) {
    throw new ToolUserError('automation_id is required for claim_next_window.', 400);
  }
  const leaseSeconds = Math.trunc(args.lease_seconds ?? DEFAULT_LEASE_SECONDS);
  if (leaseSeconds < MIN_LEASE_SECONDS || leaseSeconds > MAX_LEASE_SECONDS) {
    throw new ToolUserError(
      `lease_seconds must be between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS}.`,
      400
    );
  }
  const hasBeforeOccurredAt = args.before_occurred_at != null;
  const hasBeforeId = args.before_id != null;
  if (hasBeforeOccurredAt !== hasBeforeId) {
    throw new ToolUserError(
      'before_occurred_at and before_id must be provided together.',
      400
    );
  }
  if (hasBeforeOccurredAt && args.run_id == null) {
    throw new ToolUserError(
      'Automation source-page cursors require run_id from the active window claim.',
      400
    );
  }

  const sql = getDb();
  const owner = encodeExternalAutomationClaimOwner(ctx);
  const claimedWindow = await sql.begin(async (tx) => {
    const [automation] = await tx<{
      organization_id: string;
      schedule: string | null;
      agent_id: string | null;
      device_worker_id: string | null;
      agent_kind: string | null;
    }>`
      SELECT organization_id, schedule, agent_id, device_worker_id, agent_kind
      FROM automations
      WHERE id = ${automationId}
        AND organization_id = ${ctx.organizationId}
        AND status = 'active'
      FOR UPDATE
    `;
    if (!automation) throw new ToolUserError(`Automation ${automationId} not found.`, 404);

    const now = new Date();
    const granularity = inferAutomationGranularityFromSchedule(automation.schedule);
    let runId: number;
    let windowStart: Date;
    let windowEnd: Date;
    let leaseExpiresAt: Date;

    if (args.run_id != null) {
      const [continuation] = await tx<{
        id: number;
        claimed_by: string | null;
        expires_at: string | Date | null;
        window_start: string;
        window_end: string;
      }>`
        SELECT id, claimed_by, expires_at,
               approved_input->>'window_start' AS window_start,
               approved_input->>'window_end' AS window_end
        FROM runs
        WHERE id = ${args.run_id}
          AND automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'running'
        FOR UPDATE
      `;
      if (
        !continuation ||
        continuation.claimed_by !== owner ||
        !continuation.expires_at ||
        new Date(continuation.expires_at).getTime() <= now.getTime()
      ) {
        throw new ToolUserError('Automation window continuation does not own an active lease.', 409);
      }
      runId = Number(continuation.id);
      windowStart = new Date(continuation.window_start);
      windowEnd = new Date(continuation.window_end);
      leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      await tx`
        UPDATE runs
        SET expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
            last_heartbeat_at = current_timestamp
        WHERE id = ${runId}
      `;
    } else {
      windowStart = await ensureExpectedAutomationWindowStart(
        tx,
        automationId,
        granularity,
        now
      );
      windowEnd = addAutomationPeriod(windowStart, granularity);
      if (windowEnd > alignToAutomationWindowStart(now, granularity)) {
        throw new ToolUserError(`Automation ${automationId} has no completed window to claim.`, 409);
      }
      await expireExternalClaims(tx, automationId);
      const active = await tx`
        SELECT id FROM runs
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status IN ('claimed', 'running')
        LIMIT 1
      `;
      if (active.length > 0) {
        throw new ToolUserError(`Automation ${automationId} already has an active window claim.`, 409);
      }
      const supersededMessage = 'Superseded by the oldest recoverable Automation window';
      await tx`
        UPDATE runs
        SET status = 'cancelled',
            outcome = ${classifyRunOutcome({
              status: 'cancelled',
              errorMessage: supersededMessage,
            })},
            completed_at = current_timestamp,
            error_message = ${supersededMessage}
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
          AND (approved_input->>'window_start')::timestamptz <> ${windowStart.toISOString()}::timestamptz
      `;
      const [pending] = await tx<{ id: number }>`
        SELECT id FROM runs
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
          AND (approved_input->>'window_start')::timestamptz = ${windowStart.toISOString()}::timestamptz
          AND (approved_input->>'window_end')::timestamptz = ${windowEnd.toISOString()}::timestamptz
        LIMIT 1
      `;
      const run = pending
        ? { runId: Number(pending.id) }
        : await createAutomationRunInTransaction(
            {
              organizationId: automation.organization_id,
              automationId,
              agentId: automation.agent_id,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
              dispatchSource: 'manual',
              deviceWorkerId: automation.device_worker_id,
              agentKind: automation.agent_kind,
            },
            tx
          );
      runId = run.runId;
      leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      const claimed = await claimPendingAutomationRun(tx, {
        runId,
        automationId,
        claimedBy: owner,
        status: 'running',
        expiresAt: leaseExpiresAt,
      });
      if (!claimed) {
        throw new ToolUserError(`Automation ${automationId} window was claimed concurrently.`, 409);
      }
    }

    const [snapshot] = await tx<{
      version_id: number | string | null;
      granularity: string | null;
    }>`
      SELECT CASE
               WHEN approved_input->>'version_id' ~ '^\\d+$'
                 THEN (approved_input->>'version_id')::bigint
               ELSE NULL
             END AS version_id,
             approved_input->>'granularity' AS granularity
      FROM runs
      WHERE id = ${runId}
        AND automation_id = ${automationId}
      LIMIT 1
    `;
    const claimedGranularity: AutomationTimeGranularity = isAutomationTimeGranularity(
      snapshot?.granularity
    )
      ? snapshot.granularity
      : granularity;

    return {
      runId,
      windowStart,
      windowEnd,
      leaseExpiresAt,
      templateVersionId:
        snapshot?.version_id == null ? null : Number(snapshot.version_id),
      granularity: claimedGranularity,
    };
  });

  try {
    const context = await handleAutomationMode(
      {
        automation_id: automationId,
        template_version_id: claimedWindow.templateVersionId ?? undefined,
        limit: args.limit,
        before_occurred_at: args.before_occurred_at,
        before_id: args.before_id,
      },
      env,
      sql,
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        excludeWorkspaceAudit: ctx.memberRole !== 'owner' && ctx.memberRole !== 'admin',
        claimedWindow: {
          runId: claimedWindow.runId,
          windowStart: claimedWindow.windowStart.toISOString(),
          windowEnd: claimedWindow.windowEnd.toISOString(),
          leaseExpiresAt: claimedWindow.leaseExpiresAt.toISOString(),
          templateVersionId: claimedWindow.templateVersionId,
          granularity: claimedWindow.granularity,
        },
        throwOnSourceError: true,
      }
    );
    if (!context.window_token || !context.window_start || !context.window_end) {
      throw new Error('Claimed Automation context is missing its signed window bounds.');
    }
    const claimContext: AutomationClaimNextWindowResult['context'] = {
      ...context,
      window_token: context.window_token,
      window_start: context.window_start,
      window_end: context.window_end,
    };
    return {
      action: 'claim_next_window',
      automation_id: String(automationId),
      run_id: claimedWindow.runId,
      lease_expires_at: claimedWindow.leaseExpiresAt.toISOString(),
      context: claimContext,
    };
  } catch (error) {
    const sourceError = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE runs
      SET status = 'failed',
          outcome = ${classifyRunOutcome({ status: 'failed', errorMessage: sourceError })},
          completed_at = current_timestamp,
          error_message = ${`Automation source context failed: ${sourceError}`}
      WHERE id = ${claimedWindow.runId}
        AND automation_id = ${automationId}
        AND status = 'running'
        AND claimed_by = ${owner}
        AND expires_at = ${claimedWindow.leaseExpiresAt.toISOString()}::timestamptz
    `;
    throw error;
  }
}

async function expireExternalClaims(tx: DbClient, automationId: number): Promise<void> {
  await tx`
    UPDATE runs
    SET status = 'timeout', outcome = ${classifyRunOutcome({ status: 'timeout' })},
        completed_at = current_timestamp,
        error_message = 'External Automation window lease expired'
    WHERE automation_id = ${automationId}
      AND run_type = 'automation'
      AND status IN ('claimed', 'running')
      AND expires_at IS NOT NULL
      AND expires_at <= current_timestamp
  `;
}

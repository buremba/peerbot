/**
 * Trigger and reaction script action handlers for manage_watchers:
 *   trigger, set_reaction_script
 */

import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { isLobuGatewayRunning } from '../../../lobu/gateway';
import logger from '../../../utils/logger';
import { getWatcherRunInfo, queueAndDispatchWatcherRun } from '../../../watchers/automation';
import { compileReactionScript } from '../../../watchers/reaction-executor';
import { requireExists } from '../helpers/db-helpers';
import type { ManageWatchersArgs } from '../manage_watchers';

// ============================================
// handleTrigger
// ============================================

export async function handleTrigger(
  args: ManageWatchersArgs,
  env: Env
): Promise<{ action: 'trigger'; watcher_id: string; run_id: number; status: string }> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for trigger action');
  }

  if (!isLobuGatewayRunning()) {
    throw new Error('Embedded Lobu is not available.');
  }
  const dispatchResult = await queueAndDispatchWatcherRun(
    Number(args.watcher_id),
    'manual',
    env,
    sql
  );

  if (dispatchResult.dispatch.failed > 0) {
    const failedRun = await getWatcherRunInfo(dispatchResult.runId, sql);
    throw new Error(failedRun?.error_message || 'Failed to dispatch watcher run.');
  }

  return {
    action: 'trigger',
    watcher_id: args.watcher_id,
    run_id: dispatchResult.runId,
    status: dispatchResult.status,
  };
}

// ============================================
// handleSetReactionScript
// ============================================

export async function handleSetReactionScript(
  args: ManageWatchersArgs,
  _env: Env
): Promise<{
  action: 'set_reaction_script';
  watcher_id: string;
  has_script: boolean;
  message: string;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for set_reaction_script');
  }

  await requireExists(sql, 'watchers', args.watcher_id, 'Watcher');

  // Reaction script is a group-shared field — every assignment in the
  // group runs the same reactions on its windows. Resolve the group once
  // and cascade across all assignments so we don't silently fork.
  const groupRows = await sql`
    SELECT watcher_group_id FROM watchers WHERE id = ${args.watcher_id} LIMIT 1
  `;
  const groupId = Number(groupRows[0].watcher_group_id);

  const script = args.reaction_script;

  if (!script || script.trim() === '') {
    await sql`
      UPDATE watchers
      SET reaction_script = NULL, reaction_script_compiled = NULL
      WHERE watcher_group_id = ${groupId}
    `;
    return {
      action: 'set_reaction_script',
      watcher_id: String(args.watcher_id),
      has_script: false,
      message: 'Reaction script removed.',
    };
  }

  const compiledCode = await compileReactionScript(script);

  await sql`
    UPDATE watchers
    SET reaction_script = ${script}, reaction_script_compiled = ${compiledCode}
    WHERE watcher_group_id = ${groupId}
  `;

  logger.info(`[manage_watchers] Set reaction script for watcher ${args.watcher_id}`);

  return {
    action: 'set_reaction_script',
    watcher_id: String(args.watcher_id),
    has_script: true,
    message:
      'Reaction script compiled and saved. It will auto-execute on future complete_window calls.',
  };
}

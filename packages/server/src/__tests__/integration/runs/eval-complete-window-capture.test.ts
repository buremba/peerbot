/**
 * An eval replay must not be able to damage the Automation it is scoring.
 *
 * `complete_window` is the one write lane that does NOT go through the SDK
 * sandbox, so the capture claim has to be honoured by the handler itself. The
 * danger is specific: an eval replays the SAME window as its source run, so the
 * canvas chain root (automation + granularity + window_start) is byte-identical.
 * A `replace_existing: true` completion from an eval would therefore supersede
 * the REAL Automation's canvas head and unlink its content.
 *
 * Proves, against real Postgres:
 *   1. A live completion writes a canvas head (the control).
 *   2. A capture completion of that same window with `replace_existing: true`
 *      leaves that head byte-identical and creates no new window.
 *   3. The extraction it would have written is recorded on the eval run's
 *      `dry_run_preview`, which is what PR 3 scores.
 *   4. The reaction script does not fire.
 */

import { inferAutomationGranularityFromSchedule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import { captureSideEffect } from '../../../gateway/routes/internal/capture-mode';
import { createEvalRun } from '../../../runs/eval-runs';
import { AUTOMATION_EVAL_RUN_TYPE } from '../../../runs/run-types';
import { createAutomationRun } from '../../../runs/queue-service';
import { findCanvasHead } from '../../../utils/canvas-events';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

const LIVE_EXTRACTION = { summary: 'the real completion' };
const EVAL_EXTRACTION = { summary: 'the replay would have written this instead' };

function toolCtx(
  organizationId: string,
  userId: string,
  executionMode: 'live' | 'capture'
): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
    executionMode,
  };
}

async function setup() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Eval Capture Org' });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'eval-capture-agent',
    name: 'Eval Capture Agent',
  });

  const automation = (await workspace.owner.automations.create({
    entity_id: parentEntity.id,
    slug: 'eval-capture-automation',
    name: 'Eval Capture Automation',
    prompt: 'Summarize activity for {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationId}`;

  await createTestEvent({
    entity_id: parentEntity.id,
    organization_id: workspace.org.id,
    content: 'Something happened worth summarizing.',
    occurred_at: new Date(Date.now() - 60 * 60 * 1000),
  });

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });

  const granularity = inferAutomationGranularityFromSchedule('0 9 * * *');
  const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId, granularity);

  const queued = await createAutomationRun({
    organizationId: workspace.org.id,
    automationId,
    agentId: agent.agentId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dispatchSource: 'scheduled',
  });
  await sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`}
    WHERE id = ${queued.runId}
  `;

  const knowledge = (await api.knowledge.read({ automation_id: automationId })) as {
    window_token: string;
  };

  return {
    sql,
    orgId: workspace.org.id,
    ownerUserId,
    automationId,
    sourceRunId: queued.runId,
    windowToken: knowledge.window_token,
    canvasPeriod: {
      automationId,
      granularity,
      windowStart: windowStart.toISOString(),
    },
  };
}

describe('an eval replay cannot overwrite the Automation it is scoring', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('leaves the live canvas head intact and records the extraction instead', async () => {
    const ctx = await setup();
    const { sql, orgId, ownerUserId, automationId, sourceRunId, windowToken, canvasPeriod } = ctx;

    // 1. The control: a real completion writes a real canvas head.
    const live = await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: LIVE_EXTRACTION,
        automation_run_id: sourceRunId,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'live')
    );
    expect(live.window_created).toBe(true);
    expect(live.captured).toBeUndefined();

    // Read the head through the SAME accessor production uses, so the test
    // cannot pass by looking somewhere the writer does not write.
    const headBefore = await findCanvasHead(sql as unknown as DbClient, canvasPeriod);
    expect(headBefore).not.toBeNull();

    // Mark the source run terminal so it can be replayed.
    await sql`
      UPDATE runs SET status = 'completed', completed_at = NOW() WHERE id = ${sourceRunId}
    `;

    // 2. The attack: replay the SAME window as an eval, asking to REPLACE.
    const evalRun = await createEvalRun(
      { sourceRunId, caseKey: 'overwrite-attempt' },
      sql as unknown as DbClient
    );
    expect(evalRun?.created).toBe(true);

    const captured = await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: EVAL_EXTRACTION,
        replace_existing: true,
        automation_run_id: evalRun?.runId,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'capture')
    );

    // 3. The real head is untouched — assert this FIRST, so a regression
    // reports the damage itself rather than a missing response flag.
    const headAfter = await findCanvasHead(sql as unknown as DbClient, canvasPeriod);
    expect(headAfter?.id).toBe(headBefore?.id);
    expect(headAfter?.payloadData).toEqual(headBefore?.payloadData);
    expect(headAfter?.payloadData).toMatchObject(LIVE_EXTRACTION);

    // And exactly one canvas head still exists — the eval added no second chain.
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM events
      WHERE semantic_type = 'canvas_state'
        AND (metadata->>'automation_id')::bigint = ${automationId}
        AND superseded_by IS NULL
    `;
    expect(Number(count)).toBe(1);

    // Only now the response shape.
    expect(captured.captured).toBe(true);
    expect(captured.head_superseded).toBe(false);
    expect(captured.window_created).toBe(false);
    // The reaction block triggers on content_linked > 0 — a capture run must
    // never reach it.
    expect(captured.reaction_status).toBe('skipped');

    // 4. What the eval WOULD have written is on the run, for PR 3 to score.
    const [preview] = await sql<
      {
        dry_run: boolean;
        dry_run_preview: {
          captured: string;
          extracted_data: Record<string, unknown>;
          replace_existing: boolean;
        };
      }[]
    >`
      SELECT dry_run, dry_run_preview FROM runs WHERE id = ${evalRun?.runId ?? 0}
    `;
    expect(preview.dry_run).toBe(true);
    expect(preview.dry_run_preview.captured).toBe('complete_window');
    expect(preview.dry_run_preview.extracted_data).toMatchObject(EVAL_EXTRACTION);
    // The intent is recorded even though it was refused.
    expect(preview.dry_run_preview.replace_existing).toBe(true);
  });

  it('a live completer with no run id never adopts an in-flight eval run', async () => {
    const ctx = await setup();
    const { sql, orgId, ownerUserId, automationId, sourceRunId, windowToken } = ctx;

    // The live run stays RUNNING — it is the one a completion should land on.
    // An eval replay of the same Automation is also running and is NEWER, so the
    // fallback lookup's "prefer running, then newest" ordering would pick the
    // EVAL if it were not scoped to the caller's own lane.
    const evalRun = await createEvalRun(
      { sourceRunId, caseKey: 'race' },
      sql as unknown as DbClient
    );
    await sql`UPDATE runs SET status = 'running' WHERE id = ${evalRun?.runId ?? 0}`;

    // A LIVE completion that omits automation_run_id entirely.
    const live = await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: LIVE_EXTRACTION,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'live')
    );
    expect(live.captured).toBeUndefined();

    // The completion landed on the LIVE run. If the lookup had adopted the
    // eval, this run would still be sitting there with no window.
    const [liveRow] = await sql<{ status: string; window_id: number | null }[]>`
      SELECT status, window_id FROM runs WHERE id = ${sourceRunId}
    `;
    expect(liveRow.window_id).not.toBe(null);
    expect(liveRow.status).toBe('completed');

    // And the eval is untouched: still running, still windowless.
    const [evalRow] = await sql<
      { status: string; window_id: number | null; run_type: string }[]
    >`
      SELECT status, window_id, run_type FROM runs WHERE id = ${evalRun?.runId ?? 0}
    `;
    expect(evalRow.run_type).toBe(AUTOMATION_EVAL_RUN_TYPE);
    expect(evalRow.window_id).toBe(null);
    expect(evalRow.status).toBe('running');
  });

  it('a live completer cannot claim or complete a pending eval by passing its id', async () => {
    const ctx = await setup();
    const { sql, orgId, ownerUserId, automationId, sourceRunId, windowToken } = ctx;

    const evalRun = await createEvalRun(
      { sourceRunId, caseKey: 'claim' },
      sql as unknown as DbClient
    );
    // Make it look like a manual-open run (no agent/device pin) — the only
    // shape the claim UPDATE will touch.
    await sql`
      UPDATE runs
      SET approved_input = approved_input - 'agent_id' - 'device_worker_id'
      WHERE id = ${evalRun?.runId ?? 0}
    `;

    // A LIVE completion naming the eval's run id explicitly.
    await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: LIVE_EXTRACTION,
        automation_run_id: evalRun?.runId,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'live')
    );

    // The eval was neither claimed into 'running' nor completed with a window.
    const [evalRow] = await sql<
      { status: string; window_id: number | null; claimed_at: string | null }[]
    >`
      SELECT status, window_id, claimed_at FROM runs WHERE id = ${evalRun?.runId ?? 0}
    `;
    expect(evalRow.status).toBe('pending');
    expect(evalRow.window_id).toBe(null);
    expect(evalRow.claimed_at).toBe(null);
  });

  it('does not stamp dry_run onto a real Automation run', async () => {
    const ctx = await setup();
    const { sql, orgId, ownerUserId, automationId, sourceRunId, windowToken } = ctx;

    // A forged capture claim naming a LIVE run: the UPDATE is guarded on
    // run_type, so the real run must not be marked as a dry run.
    await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: EVAL_EXTRACTION,
        automation_run_id: sourceRunId,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'capture')
    );

    const [row] = await sql<{ dry_run: boolean | null; dry_run_preview: unknown }[]>`
      SELECT dry_run, dry_run_preview FROM runs WHERE id = ${sourceRunId}
    `;
    expect(row.dry_run ?? false).toBe(false);
    expect(row.dry_run_preview).toBeNull();
  });

  it('finalizing does not erase the side effects captured before it', async () => {
    // Two writers share `dry_run_preview`: the internal-route guard appends
    // `side_effects` as the turn runs, and finalize writes the extraction at
    // the very end. Finalize used to ASSIGN the column, so an eval that tried
    // to post to Slack and then finished lost the attempt — the exact record a
    // score is computed from.
    const ctx = await setup();
    const { sql, orgId, ownerUserId, automationId, sourceRunId, windowToken } = ctx;

    const evalRun = await createEvalRun(
      { sourceRunId, caseKey: 'merge' },
      sql as unknown as DbClient
    );
    const evalRunId = evalRun?.runId ?? 0;

    await captureSideEffect(
      {
        get: (key: string) =>
          key === 'worker'
            ? { executionMode: 'capture', automationRunId: evalRunId, organizationId: orgId }
            : undefined,
        json: (body: unknown) => new Response(JSON.stringify(body)),
      } as never,
      'conversations.send',
      { text: 'would have posted this' }
    );

    await handleCompleteWindow(
      {
        action: 'complete_window',
        automation_id: String(automationId),
        window_token: windowToken,
        extracted_data: EVAL_EXTRACTION,
        automation_run_id: evalRunId,
      } as never,
      TEST_ENV,
      toolCtx(orgId, ownerUserId, 'capture')
    );

    const [row] = await sql<
      {
        captured: string | null;
        side_effects: Array<{ action: string }> | null;
      }[]
    >`
      SELECT dry_run_preview->>'captured' AS captured,
             dry_run_preview->'side_effects' AS side_effects
      FROM runs WHERE id = ${evalRunId}
    `;
    // Both writers' records coexist.
    expect(row.captured).toBe('complete_window');
    expect(row.side_effects?.map((s) => s.action)).toEqual(['conversations.send']);
  });
});

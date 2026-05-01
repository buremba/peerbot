import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { DbClient } from '../../../db/client';
import {
  hashFailureSignature,
  maybeOpenOrAppendRepairThread,
  type RepairAgentConfig,
} from '../../../connectors/repair-agent';
import {
  buildOpenPacket,
  type DiagnosticRunRow,
} from '../../../connectors/repair-agent-packet';

/**
 * Build a tagged-template mock that matches each invocation against an
 * ordered queue of `(matcher, response)` pairs. Each matcher is a substring
 * of the SQL it should fire on — the first whose pattern is contained in
 * the joined template strings is consumed and returns its rows.
 *
 * If no pattern matches, throws — surfaces unexpected queries instead of
 * silently returning empty.
 */
function makeMockSql(plan: Array<{ match: string | RegExp; rows: any[] }>): {
  sql: DbClient;
  remaining: () => number;
  log: string[];
} {
  const queue = [...plan];
  const log: string[] = [];
  const fn = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const joined = strings.join('?');
    log.push(joined.trim().split(/\s+/).slice(0, 8).join(' '));
    const idx = queue.findIndex((item) =>
      typeof item.match === 'string'
        ? joined.includes(item.match)
        : item.match.test(joined)
    );
    if (idx === -1) {
      throw new Error(`unexpected query: ${joined.slice(0, 120)}`);
    }
    const [{ rows }] = queue.splice(idx, 1);
    const result = Object.assign(Promise.resolve(rows), {
      count: rows.length,
    }) as any;
    return result;
  }) as DbClient;
  fn.unsafe = (() => {
    throw new Error('unsafe() not supported by mock');
  }) as any;
  fn.array = ((values: any) => values) as any;
  fn.json = ((value: any) => value) as any;
  fn.begin = (async (cb: any) => cb(fn)) as any;
  return { sql: fn, remaining: () => queue.length, log };
}

const TEST_CONFIG: RepairAgentConfig = {
  threshold: 3,
  minFailingDurationMs: 30 * 60 * 1000,
  maxAttempts: 5,
  cooldownMs: 6 * 60 * 60 * 1000,
};

const NOW = Date.UTC(2026, 3, 25, 12, 0, 0); // 2026-04-25 12:00:00 UTC
const FRESH_FIRST_FAILURE = new Date(NOW - TEST_CONFIG.minFailingDurationMs - 60 * 1000); // 31 min ago

function feedRow(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 42,
    organization_id: 'org-1',
    consecutive_failures: 3,
    first_failure_at: FRESH_FIRST_FAILURE,
    repair_thread_id: null,
    repair_attempt_count: 0,
    last_repair_at: null,
    repair_agent_id: 'repair-agent',
    display_name: 'My Feed',
    config: { foo: 'bar' },
    schedule: '0 */6 * * *',
    connection_id: 7,
    connector_key: 'gmail',
    connection_display_name: 'Gmail',
    auth_profile_status: 'active',
    connector_name: 'Gmail',
    connector_version: '1.2.3',
    default_repair_agent_id: null,
    ...overrides,
  };
}

const RUN_ROW = {
  id: 99,
  status: 'failed',
  started_at: new Date(NOW - 5 * 60 * 1000),
  completed_at: new Date(NOW),
  error_message: 'token expired',
  exit_reason: 'error_message',
  exit_code: 1,
  exit_signal: null,
  output_tail: 'gmail: 401 Unauthorized\n  at refreshToken (auth.ts:42)',
};

function fakeServices() {
  const createThreadForAgent = mock(async () => ({ threadId: 'mock-thread' }));
  const enqueueAgentMessage = mock(async () => ({ jobId: 'job-1', messageId: 'msg-1' }));
  return {
    createThreadForAgent,
    enqueueAgentMessage,
    sessionManager: {} as any,
    queueProducer: {} as any,
  };
}

describe('maybeOpenOrAppendRepairThread', () => {
  let services: ReturnType<typeof fakeServices>;

  beforeEach(() => {
    services = fakeServices();
  });

  it('opens a thread when threshold met and cooldown clear (UPDATE wins)', async () => {
    const { sql } = makeMockSql([
      { match: 'FROM feeds f', rows: [feedRow()] },
      { match: 'FROM runs', rows: [RUN_ROW] },
      { match: 'UPDATE feeds', rows: [{ repair_thread_id: 'mock-conv' }] },
    ]);

    await maybeOpenOrAppendRepairThread(42, 99, {
      sql,
      services,
      config: TEST_CONFIG,
      now: () => NOW,
      mintThreadId: () => 'fixed-thread-id',
    });

    expect(services.createThreadForAgent).toHaveBeenCalledTimes(1);
    expect(services.enqueueAgentMessage).toHaveBeenCalledTimes(1);
    const enqueueArg = services.enqueueAgentMessage.mock.calls[0][1] as any;
    expect(enqueueArg.threadId).toBe('repair-agent_repair-agent_fixed-thread-id');
    expect(enqueueArg.messageText).toContain('A connector feed sync has been failing');
    expect(enqueueArg.messageText).toContain('consecutive_failures: 3');
  });

  it('skips when cooldown is active', async () => {
    const recentRepair = new Date(NOW - TEST_CONFIG.cooldownMs / 2);
    const { sql, remaining } = makeMockSql([
      {
        match: 'FROM feeds f',
        rows: [
          feedRow({
            repair_attempt_count: 1,
            last_repair_at: recentRepair,
          }),
        ],
      },
      { match: 'FROM runs', rows: [RUN_ROW] },
    ]);

    await maybeOpenOrAppendRepairThread(42, 99, {
      sql,
      services,
      config: TEST_CONFIG,
      now: () => NOW,
    });

    expect(services.createThreadForAgent).not.toHaveBeenCalled();
    expect(services.enqueueAgentMessage).not.toHaveBeenCalled();
    // Both queued queries should have been consumed: state load + recent runs.
    expect(remaining()).toBe(0);
  });

  it('skips when threshold not yet met', async () => {
    const { sql } = makeMockSql([
      { match: 'FROM feeds f', rows: [feedRow({ consecutive_failures: 2 })] },
      { match: 'FROM runs', rows: [RUN_ROW] },
    ]);
    await maybeOpenOrAppendRepairThread(42, 99, {
      sql,
      services,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    expect(services.createThreadForAgent).not.toHaveBeenCalled();
  });

  it('skips when first_failure_at is too recent', async () => {
    const { sql } = makeMockSql([
      {
        match: 'FROM feeds f',
        rows: [
          feedRow({
            first_failure_at: new Date(NOW - 60 * 1000), // 1 min ago
          }),
        ],
      },
      { match: 'FROM runs', rows: [RUN_ROW] },
    ]);
    await maybeOpenOrAppendRepairThread(42, 99, {
      sql,
      services,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    expect(services.createThreadForAgent).not.toHaveBeenCalled();
  });

  it('pauses feed (no thread) when repair_attempt_count is at the cap', async () => {
    const { sql } = makeMockSql([
      {
        match: 'FROM feeds f',
        rows: [feedRow({ repair_attempt_count: TEST_CONFIG.maxAttempts })],
      },
      { match: 'FROM runs', rows: [RUN_ROW] },
      { match: "status = 'paused'", rows: [{ id: 42 }] },
    ]);
    await maybeOpenOrAppendRepairThread(42, 99, {
      sql,
      services,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    expect(services.createThreadForAgent).not.toHaveBeenCalled();
  });

  it('only one of two racing callers wins the atomic UPDATE', async () => {
    // Caller A: load_state + recent_runs + UPDATE returns 1 row (won)
    const callA = makeMockSql([
      { match: 'FROM feeds f', rows: [feedRow()] },
      { match: 'FROM runs', rows: [RUN_ROW] },
      { match: 'UPDATE feeds', rows: [{ repair_thread_id: 'won' }] },
    ]);
    // Caller B: same gating passes, but the UPDATE returns 0 rows because
    // caller A already filled in repair_thread_id.
    const callB = makeMockSql([
      { match: 'FROM feeds f', rows: [feedRow()] },
      { match: 'FROM runs', rows: [RUN_ROW] },
      { match: 'UPDATE feeds', rows: [] },
    ]);

    const servicesA = fakeServices();
    const servicesB = fakeServices();

    await Promise.all([
      maybeOpenOrAppendRepairThread(42, 99, {
        sql: callA.sql,
        services: servicesA,
        config: TEST_CONFIG,
        now: () => NOW,
      }),
      maybeOpenOrAppendRepairThread(42, 99, {
        sql: callB.sql,
        services: servicesB,
        config: TEST_CONFIG,
        now: () => NOW,
      }),
    ]);

    expect(servicesA.createThreadForAgent).toHaveBeenCalledTimes(1);
    expect(servicesA.enqueueAgentMessage).toHaveBeenCalledTimes(1);
    expect(servicesB.createThreadForAgent).not.toHaveBeenCalled();
    expect(servicesB.enqueueAgentMessage).not.toHaveBeenCalled();
  });
});

describe('hashFailureSignature', () => {
  it('returns the same hash for identical signatures', () => {
    const a: DiagnosticRunRow = {
      id: 1,
      status: 'failed',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorMessage: 'boom',
      exitReason: 'error_message',
      exitCode: 1,
      exitSignal: null,
      outputTail: 'tail',
    };
    const b = { ...a, id: 2 };
    expect(hashFailureSignature(a)).toEqual(hashFailureSignature(b));
  });

  it('differs when output_tail differs', () => {
    const a: DiagnosticRunRow = {
      id: 1,
      status: 'failed',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorMessage: 'boom',
      exitReason: 'error_message',
      exitCode: 1,
      exitSignal: null,
      outputTail: 'tail-a',
    };
    const b = { ...a, outputTail: 'tail-b' };
    expect(hashFailureSignature(a)).not.toEqual(hashFailureSignature(b));
  });
});

describe('buildOpenPacket', () => {
  it('preserves the worker-redacted output_tail verbatim and does not introduce raw values from elsewhere', () => {
    // Worker-side redaction replaces secrets with a sentinel like
    // `[REDACTED:bearer]`. The packet builder must NOT mention any raw
    // value — it has access only to the row fields it's handed, all of
    // which are already redacted by the worker.
    const REDACTED_TAIL = [
      'gmail: response { Authorization: [REDACTED:bearer] }',
      'token=[REDACTED:apiKey]',
      'cookie=[REDACTED:cookie]',
    ].join('\n');

    const packet = buildOpenPacket({
      feedId: 42,
      feedDisplayName: 'My Feed',
      connectorKey: 'gmail',
      connectorName: 'Gmail',
      connectorVersion: '1.2.3',
      feedConfig: { folder: 'INBOX' },
      feedSchedule: '0 */6 * * *',
      consecutiveFailures: 4,
      firstFailureAt: '2026-04-25T11:00:00.000Z',
      connectionId: 7,
      connectionDisplayName: 'Gmail (work)',
      authProfileStatus: 'active',
      recentRuns: [
        {
          id: 99,
          status: 'failed',
          startedAt: '2026-04-25T11:55:00.000Z',
          completedAt: '2026-04-25T12:00:00.000Z',
          durationMs: 300000,
          errorMessage: 'token expired',
          exitReason: 'error_message',
          exitCode: 1,
          exitSignal: null,
          outputTail: REDACTED_TAIL,
        },
      ],
    });

    // The redacted sentinels MUST appear verbatim — if they didn't, the
    // builder lost the worker's redaction.
    expect(packet).toContain('[REDACTED:bearer]');
    expect(packet).toContain('[REDACTED:apiKey]');
    expect(packet).toContain('[REDACTED:cookie]');

    // Things the builder MUST NOT invent / inject from elsewhere:
    //   - actual bearer / api key / cookie values
    //   - any hard-coded credential string
    // These would mean the builder pulled raw data from outside the row.
    const forbiddenSubstrings = [
      'Authorization: Bearer ', // unredacted bearer header
      'sk-ant-', // anthropic key prefix
      'AKIA', // AWS access key prefix
      'eyJhbGc', // JWT prefix
    ];
    for (const needle of forbiddenSubstrings) {
      expect(packet).not.toContain(needle);
    }

    // Structural smoke checks.
    expect(packet).toContain('Connector feed repair — Gmail / My Feed');
    expect(packet).toContain('consecutive_failures: 4');
    expect(packet).toContain('first_failure_at: 2026-04-25T11:00:00.000Z');
    expect(packet).toContain('connector-source MCP tool');
  });
});

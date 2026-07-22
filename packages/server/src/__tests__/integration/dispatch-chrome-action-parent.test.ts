import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { dispatchChromeAction } from '../../worker-api/dispatch-chrome-action';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const sql = getTestDb();
const app = new Hono<{ Bindings: Env }>();
app.post('/dispatch', dispatchChromeAction);

describe('dispatchChromeAction parent run authorization', () => {
  beforeEach(cleanupTestDatabase);
  afterAll(cleanupTestDatabase);

  it('accepts a claimed connector action parent', async () => {
    const org = await createTestOrganization({ name: 'Chrome action parent' });
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, status, claimed_by, claimed_at
      ) VALUES (
        ${org.id}, 'action', 'prepare_comment', 'running', 'connector-worker-1', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const response = await app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: Number(run.id),
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: { url: 'https://www.linkedin.com/' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('No online paired Owletto'),
    });
  });
});

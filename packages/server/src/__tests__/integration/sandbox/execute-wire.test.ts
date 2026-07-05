/**
 * `run_sdk` MCP tool round-trip through the sandbox.
 *
 * Complementary to sandbox/client-sdk-org and namespace-dispatch (which test
 * the SDK directly): this exercises the wire path — JSON-RPC → tool dispatch
 * → isolated-vm → SDK call → response shape.
 *
 * Skipped automatically if isolated-vm cannot load (e.g. local Node 25 without
 * matching prebuilds); CI pins Node 22 where the abi127 prebuild ships.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient, TestMcpClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

function isolatedVmAvailable(): boolean {
  // isolated-vm ships prebuilds for abi127 (Node 22), abi137 (Node 24), and
  // isolated-vm-next for Node 26+. We can't actually try `new Isolate()` to
  // detect — on a wrong ABI it segfaults. Gate on ABI + the package being on
  // disk (bun install optional dep).
  const abi = process.versions.modules;
  const abiOk = abi === '127' || abi === '137' || abi === '147';
  if (!abiOk) return false;
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  return (
    existsSync(join(root, 'node_modules/isolated-vm')) ||
    existsSync(join(root, 'node_modules/isolated-vm-next'))
  );
}

describe('sandbox run (wire)', () => {
  let orgSlug: string;
  let token: string;
  const isolatedAvailable = isolatedVmAvailable();

  beforeAll(async () => {
    await cleanupTestDatabase();

    const org = await createTestOrganization({ name: 'Sandbox Wire Org' });
    const user = await createTestUser({ email: 'sandbox-wire@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    const oauthResult = await createTestAccessToken(user.id, org.id, oauthClient.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    orgSlug = org.slug;
    token = oauthResult.token;

    const seedClient = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    await seedClient.entity_schema.createType({ slug: 'company', name: 'Company' });
    await seedClient.entities.create({ type: 'company', name: 'Sandbox Co' });
  });

  it('runs a trivial script and returns its result', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, _client) => ({ ok: true, n: 42 });`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"ok":true');
    expect(json).toContain('"n":42');
  });

  it('runs a script that calls into client.entities.list (real SDK round-trip)', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const list = await client.entities.list({ entity_type: 'company' });
         return { count: list.entities?.length ?? 0 };
       };`
    );
    const json = JSON.stringify(result);
    // We seeded one company; the script should see it.
    expect(json).toContain('"count":1');
  });

  it('run_sdk can list schedules via client.schedules.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.schedules.list();
         return { hasSchedules: Array.isArray(out.schedules) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasSchedules":true');
  });

  it('query_sdk can list watchers via client.watchers.list (replaces list_watchers)', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.querySdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.watchers.list({ status: 'active' });
         return { hasWatchers: Array.isArray(out.watchers) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasWatchers":true');
  });

  it('run_sdk can create an agent via client.agents.create', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.agents.create({
           agent_id: 'wire-test-agent',
           name: 'Wire Test Agent',
         });
         return out;
       };`,
      { timeout_ms: 15_000 }
    );
    expect(JSON.stringify(result)).toContain('"action":"create"');
  });

  it('query_sdk can list metrics via client.metrics.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.querySdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.metrics.list();
         return { hasCatalog: Array.isArray(out.entity_types) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasCatalog":true');
  });

  it('run_sdk can list agents via client.agents.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.agents.list();
         return { action: out.action, n: out.agents?.length ?? 0 };
       };`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"action":"list"');
    expect(json).toMatch(/"n":\d+/);
  });

});

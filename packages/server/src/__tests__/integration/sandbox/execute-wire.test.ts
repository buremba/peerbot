/**
 * `run` MCP tool round-trip through the sandbox.
 *
 * Complementary to sandbox/client-sdk-org and namespace-dispatch (which test
 * the SDK directly): this exercises the wire path — JSON-RPC → tool dispatch
 * → isolated-vm → SDK call → response shape.
 *
 * Skipped automatically if isolated-vm cannot load (e.g. local Node 25 without
 * matching prebuilds); CI pins Node 22 where the abi127 prebuild ships.
 */

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
  // isolated-vm ships prebuilds for abi127 (Node 22) and abi137 (Node 24).
  // We can't actually try `new Isolate()` to detect — on a wrong ABI it
  // segfaults, which we can't recover from. So gate on `process.versions.modules`
  // matching a known-good value. CI pins Node 22 explicitly.
  const abi = process.versions.modules;
  return abi === '127' || abi === '137';
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
    const oauthResult = await createTestAccessToken(user.id, org.id, oauthClient.client_id);

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
    const result = await client.run<unknown>(
      `export default async (_ctx, _client) => ({ ok: true, n: 42 });`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"ok":true');
    expect(json).toContain('"n":42');
  });

  it('runs a script that calls into client.entities.list (real SDK round-trip)', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.run<unknown>(
      `export default async (_ctx, client) => {
         const list = await client.entities.list({ entity_type: 'company' });
         return { count: list.entities?.length ?? 0 };
       };`
    );
    const json = JSON.stringify(result);
    // We seeded one company; the script should see it.
    expect(json).toContain('"count":1');
  });
});

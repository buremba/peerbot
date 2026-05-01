/**
 * Layer 2 — Memory Loop Agent E2E Test
 *
 * Drives `openclaw agent --local` through the Owletto plugin to exercise
 * memory save (via tool call) and recall (via autoRecall hook).
 *
 * Uses DIFFERENT session IDs for save and recall so the recall agent has
 * NO conversation context — it can only answer correctly if autoRecall
 * injected the memory from the MCP server.
 *
 * Prerequisites:
 *   - docker compose up (app, redis, embeddings, openclaw)
 *   - DATABASE_URL, BETTER_AUTH_SECRET, ZAI_API_KEY in env (or .env)
 *   - zai model provider configured in the openclaw container
 */

import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_URL,
  addUserToOrg,
  cleanupTestData,
  closeDb,
  createTestOrg,
  oauthApproveDevice,
  oauthDeviceAuthorize,
  oauthExchangeDeviceCode,
  oauthRegisterClient,
  patchOpenclawPluginConfig,
  removeAuthFile,
  restoreOpenclawPluginConfig,
  runOpenclawAgent,
  type SignedUpUser,
  seedAuthFile,
  signUpTestUser,
  syncPluginDist,
  type TestOrg,
} from './helpers';

const SKIP = !process.env.ZAI_API_KEY;

let org: TestOrg;
let signedUp: SignedUpUser;

beforeAll(async () => {
  if (SKIP) return;

  // Verify docker containers are running
  try {
    const health = await fetch(`${APP_URL}/health`);
    if (!health.ok) throw new Error(`App health check returned ${health.status}`);
  } catch (err) {
    throw new Error(`Cannot reach app at ${APP_URL}. Is docker compose up?\n${err}`);
  }

  try {
    execSync('docker inspect openclaw-plugin-1 --format "{{.State.Running}}"', {
      encoding: 'utf-8',
    }).trim();
  } catch {
    throw new Error('openclaw-plugin-1 container is not running');
  }

  // Sign up a real user via Better Auth
  signedUp = await signUpTestUser();
  org = await createTestOrg();
  await addUserToOrg(signedUp.userId, org.id, 'owner');

  // Complete a device-auth flow to get real tokens
  const client = await oauthRegisterClient('mcp:read mcp:write');
  const authz = await oauthDeviceAuthorize(
    client.clientId,
    'mcp:read mcp:write',
    `${APP_URL}/${org.slug}`
  );
  await oauthApproveDevice(authz.user_code, signedUp.cookieHeader, org.id);
  const tokens = await oauthExchangeDeviceCode(
    client.clientId,
    authz.device_code,
    client.clientSecret
  );

  // Stop the container first so the config file watcher doesn't trigger a
  // disruptive "full process restart" when we write to the mounted volume.
  execSync('docker stop openclaw-plugin-1', {
    encoding: 'utf-8',
    timeout: 15_000,
  });

  // Sync the built plugin dist, seed auth file, and patch config — all
  // while the container is stopped so the file-watcher can't intervene.
  syncPluginDist();
  seedAuthFile({
    mcpUrl: `http://app:8787/mcp/${org.slug}`,
    issuer: 'http://app:8787',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: tokens.refresh_token!,
    accessToken: tokens.access_token,
  });
  patchOpenclawPluginConfig(org.slug);

  // Start the container — it reads the patched config + auth file on boot
  execSync('docker start openclaw-plugin-1', {
    encoding: 'utf-8',
    timeout: 10_000,
  });

  // Wait for it to be running and the plugin to initialize
  for (let i = 0; i < 30; i++) {
    try {
      const running = execSync('docker inspect openclaw-plugin-1 --format "{{.State.Running}}"', {
        encoding: 'utf-8',
      }).trim();
      if (running !== 'true') {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const logs = execSync('docker logs openclaw-plugin-1 --since 10s 2>&1', {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      if (logs.includes('ready')) break;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}, 60_000);

afterAll(async () => {
  if (SKIP) return;

  // Stop the container first so config restoration doesn't trigger the
  // file-watcher "full process restart" which kills the container.
  try {
    execSync('docker stop openclaw-plugin-1', { timeout: 15_000 });
  } catch {
    // may already be stopped
  }

  restoreOpenclawPluginConfig();
  removeAuthFile();
  await cleanupTestData();
  await closeDb();

  // Restart the container with the original config
  try {
    execSync('docker start openclaw-plugin-1', { timeout: 10_000 });
  } catch {
    // ignore — CI will tear down docker anyway
  }
});

describe.skipIf(SKIP)('memory save + recall via agent', () => {
  const saveSessionId = `e2e-save-${Date.now()}`;
  const recallSessionId = `e2e-recall-${Date.now()}`;

  it('saves a memory via agent tool call', async () => {
    // The agent should call owletto_save_knowledge when told to remember.
    // Timeout is generous because the agent may make multiple tool calls
    // (search → list entities → list schemas → save_knowledge).
    const result = runOpenclawAgent(
      'Please remember this important fact: My favorite programming language is Rust and I use it for all my systems work.',
      { sessionId: saveSessionId, timeoutMs: 120_000 }
    );

    // The agent should produce output (exit code may be non-zero if --local
    // mode has a non-zero exit convention).
    expect(result.raw.length).toBeGreaterThan(0);
  }, 150_000);

  it('recalls the memory in a fresh session via autoRecall', async () => {
    // Use a DIFFERENT session so the agent has no conversation context.
    // It can only answer correctly if autoRecall injected the saved memory.
    const result = runOpenclawAgent(
      'What is my favorite programming language? Answer in one word.',
      { sessionId: recallSessionId, timeoutMs: 90_000 }
    );

    const responseText =
      typeof result.json === 'object' && result.json !== null
        ? JSON.stringify(result.json)
        : result.raw;

    expect(responseText.toLowerCase()).toContain('rust');
  }, 120_000);
});

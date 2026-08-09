import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestConnection,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

// Marker in the stub bundle so we can assert the served HTML is ours.
const STUB_HTML =
  '<!doctype html><html><body data-test="mcp-app-interaction-stub">interaction</body></html>';

describe('MCP App resources — ui:// serving (host-authored view)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let actingAgent: Awaited<ReturnType<typeof createTestAgent>>;
  let token: string;
  let tmpRoot: string;
  const prevWebDist = process.env.WEB_DIST_DIR;

  beforeAll(async () => {
    // Serve a stub bundle from a temp dir so resources/read needs no real owletto
    // build. The resolver's first candidate is
    // `join(WEB_DIST_DIR, '..', 'dist-mcp-apps/interaction/index.html')`, so point
    // WEB_DIST_DIR at `<tmp>/dist` and write the stub under `<tmp>/dist-mcp-apps`.
    // `<tmp>/dist/index.html` deliberately does NOT exist, so the SPA dist
    // resolver in index.ts skips this WEB_DIST_DIR and is unaffected. Set this
    // BEFORE any resources/read — the bundle resolver caches misses per process.
    tmpRoot = mkdtempSync(join(tmpdir(), 'lobu-mcp-app-'));
    mkdirSync(join(tmpRoot, 'dist-mcp-apps', 'interaction'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'index.html'),
      STUB_HTML
    );
    process.env.WEB_DIST_DIR = join(tmpRoot, 'dist');

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'MCP App Org', slug: 'mcp-app-org' });
    owner = await createTestUser({ email: 'mcp-app-owner@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    actingAgent = await createTestAgent({
      organizationId: org.id,
      ownerId: owner.id,
      agentId: 'mcp-app-render-agent',
    });
    client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'mcp:admin mcp:write mcp:read profile:read',
      })
    ).token;
  });

  afterAll(() => {
    if (prevWebDist === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = prevWebDist;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function initSession(
    path: string,
    sessionToken = token,
    agentId?: string,
    forwardedHeaders: Record<string, string> = {}
  ): Promise<string> {
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lobu-test', version: '1.0', ...(agentId ? { agentId } : {}) },
        },
      },
      headers: forwardedHeaders,
      token: sessionToken,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { ...forwardedHeaders, 'mcp-session-id': sessionId! },
      token: sessionToken,
    });
    return sessionId!;
  }

  it('serves the ui://lobu/interaction bundle over resources/read', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ui://lobu/interaction/v1' },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const content = body.result?.contents?.[0];
    expect(content?.uri).toBe('ui://lobu/interaction/v1');
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    expect(content?.text).toContain('mcp-app-interaction-stub');
    expect(content?._meta?.ui).toEqual(
      expect.objectContaining({
        csp: {},
        prefersBorder: true,
      })
    );
    expect(content?._meta?.ui?.domain).toBeUndefined();
  });

  it('advertises description and restrictive CSP metadata on resources/list', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const resource = body.result?.resources?.find(
      (r: { uri: string }) => r.uri === 'ui://lobu/interaction/v1'
    );
    expect(resource).toBeDefined();
    // description is a typed resource field surfaced in client browsers.
    expect(typeof resource.description).toBe('string');
    expect(resource.description.length).toBeGreaterThan(0);
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    // This bundle is self-contained and performs no network requests. An empty
    // structured CSP asks the MCP Apps host to apply its restrictive default.
    expect(resource._meta?.ui?.csp).toEqual({});
    expect(resource._meta?.ui?.prefersBorder).toBe(true);
    // Omit ui.domain so the host supplies its isolated default sandbox origin.
    expect(resource._meta?.ui?.domain).toBeUndefined();
  });

  it('advertises a decoupled render tool with UI, OAuth, and safety metadata', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const renderTool = body.result?.tools?.find(
      (tool: { name: string }) => tool.name === 'render_lobu_view'
    );
    expect(renderTool).toEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        }),
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
        _meta: expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v1',
            visibility: ['model', 'app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v1',
        }),
      })
    );

    for (const tool of body.result?.tools ?? []) {
      expect(tool.securitySchemes?.[0]?.type).toBe('oauth2');
      expect(tool.annotations?.readOnlyHint).toEqual(expect.any(Boolean));
      expect(tool.annotations?.destructiveHint).toEqual(expect.any(Boolean));
      expect(tool.annotations?.openWorldHint).toEqual(expect.any(Boolean));
    }
  });

  it('returns a validated LobuViewV1 with a text fallback from render_lobu_view', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: {
            action: 'render',
            title: 'Release readiness',
            tone: 'default',
            blocks: [
              { type: 'text', label: 'Status', value: 'Ready for review.' },
              { type: 'code', value: 'sha: 1234abcd' },
            ],
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({
      version: 1,
      title: 'Release readiness',
      tone: 'default',
      blocks: [
        { type: 'text', label: 'Status', value: 'Ready for review.' },
        { type: 'code', value: 'sha: 1234abcd' },
      ],
      actions: [],
    });
    expect(body.result?.content?.[0]?.text).toContain('Release readiness');
    expect(body.result?.content?.[0]?.text).toContain('Ready for review\\.');
  });

  it('keeps an approval tool result text-only and renders a safe Lobu review link separately', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, token, actingAgent.agentId);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'manage_agents',
          arguments: {
            action: 'create',
            agent_id: 'mcp-app-approval-agent',
            name: 'MCP App Approval Agent',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    // The mutating tool is not coupled to UI. A separate read-only render call
    // authors the review view, so model data selection and presentation remain
    // decoupled and text-only clients still see the pending result.
    expect(body.result?._meta?.ui).toBeUndefined();
    expect(body.result?.structuredContent).toBeUndefined();
    const text = body.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    const [approval] = await getDb()<{ run_id: number }>`
      SELECT run_id
      FROM current_event_records
      WHERE organization_id = ${org.id}
        AND interaction_type = 'approval'
        AND run_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `;
    const runId = Number(approval?.run_id);
    expect(runId).toBeGreaterThan(0);

    const renderResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: { action: 'review_approval', run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const renderBody = await renderResponse.json();
    const view = renderBody.result?.structuredContent;
    expect(view?.version).toBe(1);
    expect(view?.tone).toBe('warning');
    expect(view?.actions).toEqual([
      expect.objectContaining({
        id: 'review',
        label: 'Review in Lobu',
        href: expect.stringMatching(/^https?:\/\//),
      }),
    ]);
    expect(view?.actions?.some((action: { id?: string }) => action.id === 'approve')).toBe(false);
    expect(view?.actions?.some((action: { id?: string }) => action.id === 'reject')).toBe(false);
  });

  it('does not render an approval from another member private connection', async () => {
    const member = await createTestUser({ email: 'mcp-app-member@test.example.com' });
    await addUserToOrganization(member.id, org.id, 'member');
    const memberToken = (
      await createTestAccessToken(member.id, org.id, client.client_id, {
        scope: 'mcp:read profile:read',
      })
    ).token;
    const privateConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      created_by: owner.id,
      visibility: 'private',
      createDefaultFeed: false,
    });
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connection_id,
        connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', ${privateConnection.id},
        'github', 'create_issue'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_private_approval_${runId}`,
      title: 'Private action — pending approval',
      content: 'This approval must remain private to the connection owner.',
      semanticType: 'operation',
      connectorKey: 'github',
      connectionId: privateConnection.id,
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });

    const sessionId = await initSession(`/mcp/${org.slug}`, memberToken);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 211,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: { action: 'review_approval', run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: memberToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toBe(`Approval run ${runId} was not found`);
  });

  it('bounds and redacts server-authored approval fields', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', 'github', 'create_issue'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    const fields = Object.fromEntries([
      ['apiKey', 'top-secret-value'],
      ...Array.from({ length: 100 }, (_, index) => [`field_${index}`, `value_${index}`]),
    ]);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_bounded_approval_${runId}`,
      title: `${'A'.repeat(220)} — pending approval`,
      content: 'Review this issue.',
      semanticType: 'operation',
      connectorKey: 'github',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: { fields },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 212,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: { action: 'review_approval', run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    const view = body.result?.structuredContent;
    expect(body.result?.isError).not.toBe(true);
    expect(view?.title).toHaveLength(200);
    expect(view?.blocks?.[0]?.fields).toHaveLength(100);
    expect(view?.blocks?.[0]?.fields?.[0]).toEqual({
      label: 'apiKey',
      after: '[redacted]',
    });
  });

  it('returns an MCP reauthorization challenge for a tool-level scope failure', async () => {
    const readlessToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'profile:read',
      })
    ).token;
    const forwardedHeaders = {
      'x-forwarded-host': 'lobu.ai',
      'x-forwarded-proto': 'https',
    };
    const sessionId = await initSession(
      `/mcp/${org.slug}`,
      readlessToken,
      undefined,
      forwardedHeaders
    );
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: {
            action: 'render',
            blocks: [{ type: 'text', value: 'scope probe' }],
          },
        },
      },
      headers: { ...forwardedHeaders, 'mcp-session-id': sessionId },
      token: readlessToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?._meta?.['mcp/www_authenticate']?.[0]).toContain(
      `resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource/mcp/${org.slug}"`
    );
    expect(body.result?._meta?.['mcp/www_authenticate']?.[0]).toContain(
      'error="insufficient_scope"'
    );
    expect(body.result?._meta?.['mcp/www_authenticate']?.[0]).toContain(
      'scope="mcp:read"'
    );
  });

  it('emits structuredContent for a tool that declares an outputSchema', async () => {
    // Contrast with the manage_agents case above: a tool WITH an outputSchema
    // returns matching structuredContent alongside its text content (MCP spec:
    // declaring outputSchema implies the result is structured). search_sdk is a
    // self-contained leaf, so its structuredContent shape is stable.
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_sdk', arguments: { query: 'watchers' } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        query: 'watchers',
        match_count: expect.any(Number),
        results: expect.any(Array),
      })
    );
    // The text content is still present (clients that ignore structuredContent
    // get the same data as text).
    expect(typeof body.result?.content?.[0]?.text).toBe('string');
  });
});

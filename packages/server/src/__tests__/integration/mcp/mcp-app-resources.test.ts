import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
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
    mkdirSync(join(tmpRoot, 'dist-mcp-apps', 'interaction'), {
      recursive: true,
    });
    writeFileSync(join(tmpRoot, 'dist-mcp-apps', 'interaction', 'index.html'), STUB_HTML);
    process.env.WEB_DIST_DIR = join(tmpRoot, 'dist');

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'MCP App Org',
      slug: 'mcp-app-org',
    });
    owner = await createTestUser({ email: 'mcp-app-owner@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    actingAgent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: owner.id,
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
    options: {
      sessionToken?: string;
      agentId?: string;
      advertiseMcpApps?: boolean;
      headers?: Record<string, string>;
    } = {}
  ): Promise<string> {
    const sessionToken = options.sessionToken ?? token;
    const advertiseMcpApps = options.advertiseMcpApps ?? true;
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: advertiseMcpApps
            ? {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
                  },
                },
              }
            : {},
          clientInfo: {
            name: 'lobu-test',
            version: '1.0',
            ...(options.agentId ? { agentId: options.agentId } : {}),
          },
        },
      },
      headers: options.headers,
      token: sessionToken,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: {
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token: sessionToken,
    });
    return sessionId!;
  }

  it('serves the versioned Lobu interaction bundle over resources/read', async () => {
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
    expect(content?._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
    expect(content?._meta?.ui?.prefersBorder).toBe(true);
    expect(content?._meta?.ui?.domain).toBeUndefined();
  });

  it('advertises description and CSP metadata on resources/list without claiming a dedicated app domain', async () => {
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
    // CSP rides the current nested _meta.ui shape. ui.domain is intentionally
    // absent because it means a dedicated sandbox origin, not the MCP server.
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
    expect(resource._meta?.ui?.prefersBorder).toBe(true);
    expect(resource._meta?.ui?.domain).toBeUndefined();
  });

  it('advertises a dedicated render tool with Apps, OAuth, and safety metadata', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const tool = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'render_lobu_view'
    );
    expect(tool).toEqual(
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

    const runSdk = body.result?.tools?.find((entry: { name?: string }) => entry.name === 'run_sdk');
    expect(runSdk?._meta?.ui).toBeUndefined();
    for (const listed of body.result?.tools ?? []) {
      expect(listed.securitySchemes?.[0]?.type).toBe('oauth2');
      expect(listed.annotations?.readOnlyHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.destructiveHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.openWorldHint).toEqual(expect.any(Boolean));
    }
  });

  it('returns a validated LobuViewV1 with a safe text fallback', async () => {
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
              { type: 'text', label: 'apiKey', value: 'must-not-render' },
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
        { type: 'text', label: 'apiKey', value: '[redacted]' },
      ],
      actions: [],
    });
    expect(body.result?.content?.[0]?.text).toContain('Release readiness');
    expect(body.result?.content?.[0]?.text).toContain('Ready for review\\.');
    expect(JSON.stringify(body.result)).not.toContain('must-not-render');
  });

  it('keeps the text fallback when the client does not advertise MCP Apps support', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseMcpApps: false,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const tool = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'render_lobu_view'
    );
    expect(tool?._meta?.ui).toBeUndefined();
    expect(typeof tool?.description).toBe('string');
  });

  it('keeps an approval mutation text-only and renders a safe review link separately', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      agentId: actingAgent.agentId,
    });
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
    // The mutating tool is not coupled to UI. A separate read-only call authors
    // the review view, so text-only clients still receive the pending result.
    expect(body.result?._meta?.ui).toBeUndefined();
    expect(body.result?.structuredContent).toBeUndefined();
    expect(typeof body.result?.content?.[0]?.text).toBe('string');

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
    expect(renderBody.result?.isError).not.toBe(true);
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

  it('redacts approval secrets before key context is lost and enforces view limits', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const proposal: Record<string, unknown> = {
      token: 'plaintext-top-token',
      apiKey: 'plaintext-top-api-key',
      settings: {
        authorization: 'plaintext-nested-authorization',
        endpoint: 'postgres://user:plaintext-uri-password@example.com/db',
      },
    };
    const current: Record<string, unknown> = {
      token: 'plaintext-old-token',
      apiKey: 'plaintext-old-api-key',
    };
    for (let index = 0; index < 130; index += 1) {
      proposal[`field_${index}_${'x'.repeat(150)}`] = `value_${index}_${'y'.repeat(21_000)}`;
    }
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_secret_approval_${run.id}`,
      title: `${'Long approval title '.repeat(20)}— pending approval`,
      content: 'Review the bounded proposal.',
      semanticType: 'operation',
      runId: Number(run.id),
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: { proposal, current },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 210,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: { action: 'review_approval', run_id: Number(run.id) },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const view = body.result?.structuredContent;
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('plaintext-top-token');
    expect(serialized).not.toContain('plaintext-top-api-key');
    expect(serialized).not.toContain('plaintext-old-token');
    expect(serialized).not.toContain('plaintext-old-api-key');
    expect(serialized).not.toContain('plaintext-nested-authorization');
    expect(serialized).not.toContain('plaintext-uri-password');
    expect(serialized).toContain('[redacted]');
    expect(view.title.length).toBeLessThanOrEqual(200);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.actions.length).toBeLessThanOrEqual(10);
    const diffFields = view.blocks.flatMap((block: any) => block.fields ?? []);
    expect(diffFields.length).toBeLessThanOrEqual(100);
    for (const field of diffFields) {
      expect(field.label.length).toBeLessThanOrEqual(120);
      expect(field.before?.length ?? 0).toBeLessThanOrEqual(20_000);
      expect(field.after.length).toBeLessThanOrEqual(20_000);
    }
  });

  it('does not render an approval from another member private connection', async () => {
    const member = await createTestUser({
      email: 'mcp-app-member@test.example.com',
    });
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

    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: memberToken,
    });
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

  it('retains the initialized public resource URL in a later scope challenge', async () => {
    const readlessToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'profile:read',
      })
    ).token;
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: readlessToken,
      headers: {
        host: 'internal.service:8787',
        'x-forwarded-host': 'mcp.public.example',
        'x-forwarded-proto': 'https',
      },
    });
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
      // Deliberately omit forwarded headers after initialize. The transport
      // must challenge against the canonical URL retained by the session.
      headers: { 'mcp-session-id': sessionId },
      token: readlessToken,
    });
    const body = await response.json();
    const challenge = body.result?._meta?.['mcp/www_authenticate']?.[0];
    expect(body.result?.isError).toBe(true);
    expect(challenge).toContain(
      `resource_metadata="https://mcp.public.example/.well-known/oauth-protected-resource/mcp/${org.slug}"`
    );
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:read"');
    expect(challenge).not.toContain('internal.service');
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

  it('keeps x-mcp-format isolated across concurrent MCP sessions', async () => {
    const jsonSessionId = await initSession(`/mcp/${org.slug}`);
    const markdownSessionId = await initSession(`/mcp/${org.slug}`);

    // Keep the JSON-formatted request inside its tool handler while a second
    // request enters the MCP boundary with the default markdown format. A
    // process-global format flag lets the second request overwrite the first.
    const jsonRequest = post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'query_sdk',
          arguments: {
            script:
              'export default async (ctx) => { await ctx.sleep(150); return { marker: "json-session" }; };',
          },
        },
      },
      headers: {
        'mcp-session-id': jsonSessionId,
        'x-mcp-format': 'json',
      },
      token,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const markdownResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'search_sdk', arguments: { query: 'entities.list' } },
      },
      headers: { 'mcp-session-id': markdownSessionId },
      token,
    });

    expect(markdownResponse.status).toBe(200);
    const markdownBody = await markdownResponse.json();
    expect(markdownBody.result?.content?.[0]?.text).toMatch(/^```json/);

    const jsonResponse = await jsonRequest;
    expect(jsonResponse.status).toBe(200);
    const jsonBody = await jsonResponse.json();
    const jsonText = jsonBody.result?.content?.[0]?.text as string;
    expect(jsonText).toMatch(/^\{/);
    expect(JSON.parse(jsonText)).toMatchObject({
      success: true,
      return_value: { marker: 'json-session' },
    });
  });
});

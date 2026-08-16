import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
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
import { get, post } from '../../setup/test-helpers';

const STUB_EMBEDDED_HTML =
  '<!doctype html><html><body data-test="mcp-app-embedded-stub">embedded</body></html>';
const STUB_EXTERNAL_HTML =
  '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src __LOBU_MCP_APP_ORIGIN__"><link rel="stylesheet" href="./assets/app.css?v=css123"><script type="module" src="./assets/app.js?v=js123"></script></head><body data-test="mcp-app-external-stub">external</body></html>';

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
    mkdirSync(join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'legacy-v2.html'),
      STUB_EMBEDDED_HTML
    );
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'index.html'),
      STUB_EXTERNAL_HTML
    );
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets', 'app.js'),
      'document.body.dataset.mcpAppAsset = "loaded";'
    );
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets', 'app.css'),
      '[data-mcp-app] { display: block; }'
    );
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

  it('serves the self-contained v13 interaction bundle over resources/read', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ui://lobu/interaction/v13.html' },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const content = body.result?.contents?.[0];
    expect(content?.uri).toBe('ui://lobu/interaction/v13.html');
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    expect(content?.text).toContain('mcp-app-embedded-stub');
    expect(content?.text).not.toContain('mcp-app-external-stub');
    expect(content?.text).not.toContain('./assets/');
    expect(content?.text).not.toContain('<base ');
    expect(content?._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
    expect(content?._meta?.ui?.permissions).toEqual({ clipboardWrite: {} });
    expect(content?._meta?.ui?.prefersBorder).toBe(true);
    expect(content?._meta?.ui?.domain).toBeUndefined();
  });

  it('serves the stamped external template and registered stable assets', async () => {
    const htmlResponse = await get('/mcp-apps/interaction/index.html');
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain('mcp-app-external-stub');
    expect(html).toContain('/mcp-apps/interaction/');
    expect(html).not.toContain('__LOBU_MCP_APP_ORIGIN__');

    const assetResponse = await get('/mcp-apps/interaction/assets/app.js');
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('text/javascript');
    expect(assetResponse.headers.get('cache-control')).toBe('no-cache');
    expect(assetResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(assetResponse.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(await assetResponse.text()).toContain('mcpAppAsset');

    const styleResponse = await get('/mcp-apps/interaction/assets/app.css');
    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get('content-type')).toContain('text/css');
    expect(styleResponse.headers.get('cache-control')).toBe('no-cache');
    expect(styleResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(styleResponse.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(await styleResponse.text()).toContain('[data-mcp-app]');

    expect((await get('/mcp-apps/interaction/assets/app.txt')).status).toBe(404);
    expect((await get('/mcp-apps/unknown/assets/app.js')).status).toBe(404);
  });

  it('keeps v1 and v2 aliases on the packed, network-free template', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    for (const uri of ['ui://lobu/interaction/v1', 'ui://lobu/interaction/v2']) {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: uri,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      expect(response.status).toBe(200);
      const content = (await response.json()).result?.contents?.[0];
      expect(content?.uri).toBe(uri);
      expect(content?.mimeType).toBe('text/html;profile=mcp-app');
      expect(content?.text).toContain('mcp-app-embedded-stub');
      expect(content?.text).not.toContain('mcp-app-external-stub');
      expect(content?._meta?.ui?.csp).toEqual({
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
      });
      expect(content?._meta?.ui?.domain).toBeUndefined();
    }
  });

  it('keeps v3 through v6 aliases on the external template they originally referenced', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    for (const uri of [
      'ui://lobu/interaction/v3.html',
      'ui://lobu/interaction/v4.html',
      'ui://lobu/interaction/v5.html',
      'ui://lobu/interaction/v6.html',
    ]) {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: uri,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });

      expect(response.status).toBe(200);
      const content = (await response.json()).result?.contents?.[0];
      expect(content?.uri).toBe(uri);
      expect(content?.mimeType).toBe('text/html;profile=mcp-app');
      expect(content?.text).toContain('mcp-app-external-stub');
      expect(content?.text).not.toContain('mcp-app-embedded-stub');
      expect(content?.text).toContain('./assets/app.js?v=js123');
      const baseHref = content?.text?.match(/<base href="([^"]+)" \/>/)?.[1];
      const resourceOrigin = new URL(baseHref!).origin;
      expect(content?._meta?.ui?.csp).toEqual({
        connectDomains: [],
        resourceDomains: [resourceOrigin],
        frameDomains: [],
        baseUriDomains: [resourceOrigin],
      });
    }
  });

  it('keeps the v7 through v12 aliases on the packed, network-free template', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    for (const uri of [
      'ui://lobu/interaction/v7.html',
      'ui://lobu/interaction/v8.html',
      'ui://lobu/interaction/v9.html',
      'ui://lobu/interaction/v10.html',
      'ui://lobu/interaction/v11.html',
      'ui://lobu/interaction/v12.html',
    ]) {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: uri,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      expect(response.status).toBe(200);
      const content = (await response.json()).result?.contents?.[0];
      expect(content?.uri).toBe(uri);
      expect(content?.text).toContain('mcp-app-embedded-stub');
      expect(content?.text).not.toContain('./assets/');
    }
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
      (r: { uri: string }) => r.uri === 'ui://lobu/interaction/v13.html'
    );
    expect(resource).toBeDefined();
    expect(
      body.result?.resources?.filter((r: { uri?: string }) =>
        r.uri?.startsWith('ui://lobu/interaction/')
      )
    ).toHaveLength(1);
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

  it('links direct saves and explicit view-producing tools to the App resource and keeps helpers app-only', async () => {
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
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: false,
        }),
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
        _meta: expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v13.html',
            visibility: ['model', 'app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v13.html',
        }),
      })
    );

    const saveMemory = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'save_memory'
    );
    expect(saveMemory).toEqual(
      expect.objectContaining({
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
        _meta: expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v13.html',
            visibility: ['model', 'app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v13.html',
        }),
      })
    );

    // Reads and general SDK actions stay headless so multi-step work does not
    // mount an iframe for every intermediate call. save_memory is the narrow
    // exception: its one durable write is itself the final inspectable result.
    for (const name of [
      'search_memory',
      'search_sdk',
      'query_sdk',
      'query_sql',
      'run_sdk',
    ]) {
      const dataTool = body.result?.tools?.find(
        (entry: { name?: string }) => entry.name === name
      );
      expect(dataTool).toBeDefined();
      expect(dataTool?._meta?.ui).toBeUndefined();
      expect(dataTool?._meta?.['openai/outputTemplate']).toBeUndefined();
      expect(dataTool?.outputSchema).toEqual(expect.objectContaining({ type: 'object' }));
    }

    const resolveApproval = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'resolve_lobu_approval'
    );
    expect(resolveApproval).toEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
          idempotentHint: false,
        }),
        outputSchema: expect.objectContaining({ type: 'object' }),
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
        _meta: expect.objectContaining({
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v13.html',
            visibility: ['app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v13.html',
        }),
      })
    );
    for (const name of ['restore_lobu_app_result', 'save_lobu_app_state']) {
      const helper = body.result?.tools?.find(
        (entry: { name?: string }) => entry.name === name
      );
      expect(helper).toEqual(
        expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
          _meta: expect.objectContaining({
            ui: { visibility: ['app'] },
          }),
        })
      );
      expect(helper?._meta?.ui?.resourceUri).toBeUndefined();
    }
    for (const listed of body.result?.tools ?? []) {
      expect(listed.securitySchemes?.[0]?.type).toBe('oauth2');
      expect(listed.annotations?.readOnlyHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.destructiveHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.openWorldHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.idempotentHint).toEqual(expect.any(Boolean));
      expect(listed.outputSchema).toEqual(expect.objectContaining({ type: 'object' }));
    }
  });

  it('preserves negotiated Apps metadata after cross-replica session recovery', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    clearInMemoryMcpSessionsForTests();

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
    expect(tool?._meta?.ui).toEqual(
      expect.objectContaining({
        resourceUri: 'ui://lobu/interaction/v13.html',
        visibility: ['model', 'app'],
      })
    );
  });

  it('returns the exact saved event payload for the save_memory App card', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const payloadTemplate = {
      root: {
        type: 'bar-chart',
        data: '{{points}}',
        labelField: 'label',
        valueField: 'value',
      },
    };
    const payloadData = {
      points: [
        { label: 'Saved', value: 12 },
        { label: 'Rendered', value: 7 },
      ],
    };
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-app-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Saved chart',
            semantic_type: 'content',
            payload_type: 'json_template',
            payload_template: payloadTemplate,
            payload_data: payloadData,
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-render-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Saved chart',
        payload_type: 'json_template',
        payload_data: payloadData,
        payload_template: payloadTemplate,
        payload_text: null,
        attachments: [],
        source_url: null,
        view_url: expect.stringContaining('content_ids='),
      })
    );
    expect(body.result?.content?.[0]?.text).toContain('"title": "Saved chart"');
    expect(body.result?.content?.[0]?.text).not.toContain('payload_data');
    expect(body.result?.content?.[0]?.text).not.toContain('payload_template');
  });

  it('keeps oversized saved payloads out of the App response', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-oversized-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Large durable note',
            semantic_type: 'content',
            payload_type: 'json_template',
            payload_template: { root: { type: 'data', path: 'body' } },
            payload_data: { body: 'x'.repeat(600 * 1024) },
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-oversized-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Large durable note',
        view_url: expect.stringContaining('content_ids='),
        exact_read: expect.objectContaining({
          method: 'client.knowledge.read',
        }),
      })
    );
    for (const key of [
      'payload_type',
      'payload_text',
      'payload_data',
      'payload_template',
      'attachments',
      'source_url',
    ]) {
      expect(body.result?.structuredContent).not.toHaveProperty(key);
    }
    expect(body.result?.content?.[0]?.text.length).toBeLessThan(10_000);
  });

  it('omits the saved payload when the client does not advertise MCP Apps', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseMcpApps: false,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-no-app-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Plain note',
            semantic_type: 'content',
            content: 'body-visible-only-to-app-hosts',
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-no-app-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    // The write still succeeds and stays exactly readable by id — only the
    // inline render payload, which this client cannot render, is withheld.
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Plain note',
        exact_read: expect.objectContaining({ method: 'client.knowledge.read' }),
      })
    );
    for (const key of [
      'payload_type',
      'payload_text',
      'payload_data',
      'payload_template',
      'attachments',
      'source_url',
    ]) {
      expect(body.result?.structuredContent).not.toHaveProperty(key);
    }
    expect(body.result?.content?.[0]?.text).not.toContain(
      'body-visible-only-to-app-hosts'
    );
  });

  it('keeps ClientSDK saves headless when their source session supports Apps', async () => {
    // run_sdk builds this same in-process SDK from the outer MCP session. The
    // direct SDK call keeps the boundary test independent of isolated-vm.
    await initWorkspaceProvider();
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      scopedToOrg: true,
      allowCrossOrg: false,
      mcpAppsSupported: true,
    };
    const sdk = buildClientSDK(ctx, {
      ENVIRONMENT: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
    } as Env);
    const receipt = await sdk.knowledge.save({
      title: 'Nested SDK save',
      semantic_type: 'content',
      content: 'nested-sdk-save-body-must-stay-headless',
      metadata: {},
      idempotency_key: 'mcp-app-nested-sdk-save-headless',
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        title: 'Nested SDK save',
        exact_read: expect.objectContaining({ method: 'client.knowledge.read' }),
      })
    );
    for (const key of [
      'payload_type',
      'payload_text',
      'payload_data',
      'payload_template',
      'attachments',
      'source_url',
    ]) {
      expect(receipt).not.toHaveProperty(key);
    }
    expect(JSON.stringify(receipt)).not.toContain('nested-sdk-save-body-must-stay-headless');
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

  it('returns the viewer member role on every app-rendered result and nowhere else', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const call = async (
      name: string,
      args: Record<string, unknown>,
      callToken = token,
      session = sessionId
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: `member-role-${name}`,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        headers: { 'mcp-session-id': session },
        token: callToken,
      });
      return (await response.json()).result;
    };

    // The role rides on the explicit user-facing view and app-only helpers.
    const viewResult = await call('render_lobu_view', {
      action: 'render',
      blocks: [{ type: 'text', value: 'owner view' }],
    });
    expect(viewResult?.isError).not.toBe(true);
    expect(viewResult?._meta?.['lobu/member-role']).toBe('owner');

    const restoreResult = await call('restore_lobu_app_result', {
      tool_call_id: 'member-role-unknown-card',
      tool_name: 'render_lobu_view',
    });
    expect(restoreResult?.structuredContent?.found).toBe(false);
    expect(restoreResult?._meta?.['lobu/member-role']).toBe('owner');

    // A headless data tool has no app view to gate, so it stays clean.
    const sqlResult = await call('query_sql', { sql: 'SELECT 1 AS row_number' });
    expect(sqlResult?.isError).not.toBe(true);
    expect(sqlResult?._meta?.['lobu/member-role']).toBeUndefined();

    // The role is the caller's own membership row, not a constant: a plain
    // member gets 'member' and the app hides the toggle for them.
    const memberUser = await createTestUser({
      email: 'mcp-app-member-role@test.example.com',
    });
    await addUserToOrganization(memberUser.id, org.id, 'member');
    const memberToken = (
      await createTestAccessToken(memberUser.id, org.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;
    const memberSession = await initSession(`/mcp/${org.slug}`, {
      sessionToken: memberToken,
    });
    const memberResult = await call(
      'render_lobu_view',
      {
        action: 'render',
        blocks: [{ type: 'text', value: 'member view' }],
      },
      memberToken,
      memberSession
    );
    expect(memberResult?.isError).not.toBe(true);
    expect(memberResult?._meta?.['lobu/member-role']).toBe('member');
  });

  it('emits canonical null member role for a public-workspace reader with no membership', async () => {
    // An authenticated caller with NO membership row, reading a PUBLIC org over
    // `/mcp/{slug}`, is admitted by `allowPublicOrgWithoutMembership` with a
    // null role. The app's Debug (raw JSON) disclosure must stay closed for
    // them, so the key must be PRESENT with canonical null — never omitted.
    const publicOrg = await createTestOrganization({
      name: 'MCP App Public Org',
      slug: 'mcp-app-public-org',
      visibility: 'public',
    });
    const visitor = await createTestUser({
      email: 'mcp-app-public-reader@test.example.com',
    });
    // Token bound to the public org, but the user is deliberately NOT a member.
    const visitorToken = (
      await createTestAccessToken(visitor.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;

    const sessionId = await initSession(`/mcp/${publicOrg.slug}`, {
      sessionToken: visitorToken,
    });
    const response = await post(`/mcp/${publicOrg.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'public-reader-app-render',
        method: 'tools/call',
        params: {
          // The member role rides on `mcpMeta.ui` (mcp-handler.ts), so only an
          // explicit user-facing render has an app to inform of the role. This
          // tool renders host-authored blocks without reading
          // org-private data, so it keeps the caller org-independent.
          name: 'render_lobu_view',
          arguments: {
            action: 'render',
            blocks: [{ type: 'text', value: 'public reader' }],
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: visitorToken,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    // Canonical null: the key is present and its value is null, so the app
    // resolves the explicit downgrade instead of falling back to an alternate
    // envelope that could carry a stale role.
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBeNull();
    expect(body.result?.structuredContent?.version).toBe(1);
  });

  it('emits no member role for a tool that declares no UI resource', async () => {
    // The role exists to tell the APP who is looking. `query_sql` is headless,
    // so there is no app to tell and the key must be
    // absent — not null. Absent and null mean different things to the host:
    // null is an explicit downgrade, absent means "unchanged".
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'no-ui-tool-role',
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: { sql: 'SELECT 1 AS row_number' },
        },
      },
      headers: { 'mcp-session-id': sessionId },
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(false);
  });

  it('does not create an App snapshot for a headless data tool', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'headless-data-tool-snapshot',
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: { sql: 'SELECT 1 AS row_number' },
          _meta: { 'openai/session': 'headless-data-tool-conversation' },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.rows).toEqual([{ row_number: 1 }]);
    expect(body.result?._meta?.['lobu/member-role']).toBeUndefined();
    expect(body.result?._meta?.['lobu/mcp-app-snapshot-capability']).toBeUndefined();
  });

  it('carries canonical null member role on a thrown app-UI error for a public reader', async () => {
    // Same public non-member caller, but the UI tool THROWS instead of
    // returning a result. The app keeps its previous member role whenever the
    // `lobu/member-role` key is ABSENT — so a thrown error after a downgrade
    // would otherwise leave stale owner/admin UI state. The catch path must
    // still emit the key with canonical null.
    const publicOrg = await createTestOrganization({
      name: 'MCP App Public Throws Org',
      slug: 'mcp-app-public-throws-org',
      visibility: 'public',
    });
    const visitor = await createTestUser({
      email: 'mcp-app-public-throws@test.example.com',
    });
    // Token bound to the public org, but the user is deliberately NOT a member.
    const visitorToken = (
      await createTestAccessToken(visitor.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;

    const sessionId = await initSession(`/mcp/${publicOrg.slug}`, {
      sessionToken: visitorToken,
    });
    const response = await post(`/mcp/${publicOrg.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'public-reader-thrown-error',
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          // A genuinely thrown error, never a soft result: the approval row
          // cannot exist, so findApprovalRow throws a ToolUserError that
          // reaches the tools/call catch path.
          arguments: { action: 'review_approval', run_id: 999_999_999 },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: visitorToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toContain('was not found');
    // The key must be PRESENT with canonical null on the thrown error too.
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBeNull();
    expect(body.result?._meta?.['mcp/www_authenticate']).toBeUndefined();
  });

  it('binds reused backend request ids to distinct host cards and restores exact state', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const conversationId = 'chatgpt-conversation-restore-test';
    const renderView = async (viewNumber: number) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          // ChatGPT currently reuses this proxy-side id for several cards.
          id: 'reused-backend-request-id',
          method: 'tools/call',
          params: {
            name: 'render_lobu_view',
            arguments: {
              action: 'render',
              title: `Result ${viewNumber}`,
              blocks: [{ type: 'text', label: 'View', value: String(viewNumber) }],
            },
            _meta: { 'openai/session': conversationId },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return response.json();
    };
    const restore = async (
      toolCallId: string,
      hostConversationId = conversationId,
      toolName = 'render_lobu_view'
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: `restore-${toolCallId}`,
          method: 'tools/call',
          params: {
            name: 'restore_lobu_app_result',
            arguments: {
              tool_call_id: toolCallId,
              tool_name: toolName,
            },
            _meta: { 'openai/session': hostConversationId },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return (await response.json()).result?.structuredContent;
    };
    const bindCard = async (
      toolCallId: string,
      capability: string,
      viewState: Record<string, unknown> = {},
      capabilityTransport: 'argument' | 'metadata' = 'argument'
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: `bind-${toolCallId}`,
          method: 'tools/call',
          params: {
            name: 'save_lobu_app_state',
            arguments: {
              tool_call_id: toolCallId,
              tool_name: 'render_lobu_view',
              view_state: viewState,
              ...(capabilityTransport === 'argument'
                ? { snapshot_capability: capability }
                : {}),
            },
            _meta: {
              'openai/session': conversationId,
              ...(capabilityTransport === 'metadata'
                ? { 'lobu/mcp-app-snapshot-capability': capability }
                : {}),
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return (await response.json()).result?.structuredContent;
    };
    const restoreByCapability = async (
      capability: string,
      hostConversationId = conversationId,
      toolName = 'render_lobu_view'
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 'restore-by-capability',
          method: 'tools/call',
          params: {
            name: 'restore_lobu_app_result',
            arguments: {
              snapshot_capability: capability,
              tool_name: toolName,
            },
            _meta: { 'openai/session': hostConversationId },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return (await response.json()).result?.structuredContent;
    };
    const restoreByCardAndCapability = async (toolCallId: string, capability: string) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 'restore-by-card-and-capability',
          method: 'tools/call',
          params: {
            name: 'restore_lobu_app_result',
            arguments: {
              tool_call_id: toolCallId,
              snapshot_capability: capability,
              tool_name: 'render_lobu_view',
            },
            _meta: { 'openai/session': conversationId },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return (await response.json()).result?.structuredContent;
    };
    const bindByCapability = async (
      capability: string,
      viewState: Record<string, unknown> = {}
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 'bind-by-capability',
          method: 'tools/call',
          params: {
            name: 'save_lobu_app_state',
            arguments: {
              snapshot_capability: capability,
              tool_name: 'render_lobu_view',
              view_state: viewState,
            },
            _meta: { 'openai/session': conversationId },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      return (await response.json()).result?.structuredContent;
    };

    const firstBody = await renderView(1);
    expect(firstBody.result?.structuredContent?.title).toBe('Result 1');
    const firstCapability = firstBody.result?._meta?.['lobu/mcp-app-snapshot-capability'];
    expect(firstCapability).toEqual(expect.any(String));
    expect(await restore('host-card-1')).toEqual({ found: false, view_state: {} });
    expect(
      await bindCard('host-card-1', firstCapability, {
        'view.page': 2,
        nested: { dropped: true },
      })
    ).toEqual({ saved: true });
    expect(await restore('host-card-1', `${conversationId}-wrong`)).toEqual({
      found: false,
      view_state: {},
    });
    expect(await restore('host-card-1', conversationId, 'run_sdk')).toEqual({
      found: false,
      view_state: {},
    });
    expect(await restore('host-card-1')).toEqual({
      found: true,
      tool_name: 'render_lobu_view',
      data: firstBody.result.structuredContent,
      view_state: { 'view.page': 2 },
    });
    expect(
      await bindCard('host-card-1', firstCapability, { 'view.page': 3 })
    ).toEqual({ saved: true });
    expect((await restore('host-card-1'))?.view_state).toEqual({ 'view.page': 3 });

    const secondBody = await renderView(2);
    expect(secondBody.result?.structuredContent?.title).toBe('Result 2');
    const secondCapability = secondBody.result?._meta?.['lobu/mcp-app-snapshot-capability'];
    expect(secondCapability).toEqual(expect.any(String));
    expect(secondCapability).not.toBe(firstCapability);
    expect(await bindCard('host-card-2', secondCapability, {}, 'metadata')).toEqual({
      saved: true,
    });
    expect((await restore('host-card-1'))?.data?.title).toBe('Result 1');
    expect((await restore('host-card-2'))?.data?.title).toBe('Result 2');
    expect(
      (await restoreByCardAndCapability('host-card-1', secondCapability))?.data?.title
    ).toBe('Result 2');

    const thirdBody = await renderView(3);
    const thirdCapability = thirdBody.result?._meta?.['lobu/mcp-app-snapshot-capability'];
    expect(thirdCapability).toEqual(expect.any(String));
    expect(await bindByCapability(thirdCapability, { 'payload.open': true })).toEqual({
      saved: true,
    });
    expect(await restoreByCapability(thirdCapability)).toEqual({
      found: true,
      tool_name: 'render_lobu_view',
      data: thirdBody.result.structuredContent,
      view_state: { 'payload.open': true },
    });

    const fourthBody = await renderView(4);
    const fourthCapability = fourthBody.result?._meta?.['lobu/mcp-app-snapshot-capability'];
    expect(fourthCapability).toEqual(expect.any(String));
    expect(fourthCapability).not.toBe(thirdCapability);
    expect(await bindByCapability(fourthCapability)).toEqual({ saved: true });
    expect((await restoreByCapability(thirdCapability))?.data?.title).toBe('Result 3');
    expect((await restoreByCapability(fourthCapability))?.data?.title).toBe('Result 4');
    expect(await restoreByCapability(fourthCapability, `${conversationId}-wrong`)).toEqual({
      found: false,
      view_state: {},
    });

    const [snapshot] = await getDb()<{
      body: string;
      conversation_key: string;
      tool_call_key: string;
    }>`SELECT body, conversation_key, tool_call_key
       FROM public.mcp_app_result_snapshots
       WHERE organization_id = ${org.id}
         AND tool_name = 'render_lobu_view'
       ORDER BY updated_at DESC
       LIMIT 1`;
    expect(snapshot).toBeDefined();
    expect(snapshot.body).not.toContain('Result 4');
    expect(snapshot.conversation_key).not.toBe(conversationId);
    expect(snapshot.tool_call_key).not.toBe('host-card-2');

    const collidingBody = await renderView(5);
    const collidingCapability =
      collidingBody.result?._meta?.['lobu/mcp-app-snapshot-capability'];
    expect(await bindCard('host-card-2', collidingCapability)).toEqual({ saved: false });
    expect((await restore('host-card-2'))?.data?.title).toBe('Result 2');

    const helperAudits = await getDb()<{
      tool_name: string;
    }>`SELECT payload_data->>'tool_name' AS tool_name
       FROM events
       WHERE organization_id = ${org.id}
         AND payload_data->>'tool_name' IN ('restore_lobu_app_result', 'save_lobu_app_state')`;
    expect(helperAudits).toHaveLength(0);
  });

  it('keeps the text fallback when the client does not advertise MCP Apps support', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseMcpApps: false,
    });
    clearInMemoryMcpSessionsForTests();
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
    expect(
      body.result?.tools?.some(
        (entry: { name?: string }) => entry.name === 'resolve_lobu_approval'
      )
    ).toBe(false);

    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_non_app_approval_${runId}`,
      title: 'Non-App review — pending approval',
      content: 'This client must use the Lobu review page.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });
    const renderResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: { action: 'review_approval', run_id: runId },
        },
      },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    const renderBody = await renderResponse.json();
    expect(renderBody.result?.isError).not.toBe(true);
    expect(renderBody.result?._meta?.['lobu/approval-capability']).toBeUndefined();
    // The registered renderer still carries the viewer role, while the
    // app-only approval capability is withheld from this non-App client.
    expect(renderBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(renderBody.result?.structuredContent?.actions).toEqual([
      expect.objectContaining({ id: 'review', href: expect.stringMatching(/^https?:\/\//) }),
    ]);
  });

  it('keeps an approval mutation text-only and resolves it only with the hidden app capability', async () => {
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
    expect(view?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'approve',
          label: 'Approve',
          tool: 'resolve_lobu_approval',
          args: { run_id: runId, decision: 'approve' },
        }),
        expect.objectContaining({
          id: 'reject',
          label: 'Reject',
          tool: 'resolve_lobu_approval',
          args: { run_id: runId, decision: 'reject' },
        }),
        expect.objectContaining({
          id: 'review',
          label: 'Open in Lobu',
          href: expect.stringMatching(/^https?:\/\//),
        }),
      ])
    );
    const capability = renderBody.result?._meta?.['lobu/approval-capability'];
    expect(typeof capability).toBe('string');
    expect(capability.length).toBeGreaterThan(40);
    expect(renderBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(JSON.stringify(view)).not.toContain(capability);
    expect(renderBody.result?.content?.[0]?.text).not.toContain(capability);

    const missingCapabilityResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'resolve_lobu_approval',
          arguments: { run_id: runId, decision: 'reject' },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const missingCapabilityBody = await missingCapabilityResponse.json();
    expect(missingCapabilityBody.result?.isError).toBe(true);
    expect(missingCapabilityBody.result?.content?.[0]?.text).toMatch(/approval capability/i);
    expect(missingCapabilityBody.result?._meta?.['lobu/member-role']).toBe('owner');

    const rejectResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'resolve_lobu_approval',
          arguments: { run_id: runId, decision: 'reject', reason: 'Not this time' },
          _meta: { 'lobu/approval-capability': capability },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const rejectBody = await rejectResponse.json();
    expect(rejectBody.result?.isError).not.toBe(true);
    expect(rejectBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(rejectBody.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: expect.stringMatching(/rejected/i),
        actions: [],
      })
    );

    const [settled] = await getDb()<{
      approval_status: string;
      status: string;
      error_message: string | null;
    }>`
      SELECT approval_status, status, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${org.id}
    `;
    expect(settled).toMatchObject({
      approval_status: 'rejected',
      status: 'cancelled',
      error_message: 'Not this time',
    });

    const replayResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'resolve_lobu_approval',
          arguments: { run_id: runId, decision: 'reject' },
          _meta: { 'lobu/approval-capability': capability },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const replayBody = await replayResponse.json();
    expect(replayBody.result?.isError).toBe(true);
    expect(replayBody.result?.content?.[0]?.text).toMatch(/stale|pending/i);
  });

  it('returns structured SQL rows for the shared rich renderer', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: {
            sql: 'SELECT id, semantic_type AS name FROM events',
            sort_by: 'id',
            sort_order: 'desc',
            limit: 1,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        rows: [
          {
            id: expect.any(Number),
            name: expect.any(String),
          },
        ],
        columns: [
          { name: 'id', type: expect.any(String) },
          { name: 'name', type: expect.any(String) },
        ],
        total_count: expect.any(Number),
      })
    );
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
    const interactionInputSchema = {
      type: 'object',
      properties: {
        api_key: {
          type: 'string',
          default: 'plaintext-schema-api-key',
          description: 'Credential used for the request',
        },
        comment: { type: 'string' },
      },
      required: ['api_key'],
    };
    const interactionInput = {
      api_key: 'plaintext-form-api-key',
      comment: 'Safe existing note',
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
      interactionInputSchema,
      interactionInput,
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
    expect(serialized).not.toContain('plaintext-schema-api-key');
    expect(serialized).not.toContain('plaintext-form-api-key');
    expect(serialized).toContain('[redacted]');
    expect(view.title.length).toBeLessThanOrEqual(200);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.actions.length).toBeLessThanOrEqual(10);
    const form = view.blocks.find((block: any) => block.type === 'form');
    expect(form).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({
          properties: expect.objectContaining({
            api_key: expect.objectContaining({
              type: 'string',
              format: 'password',
              description: 'Credential used for the request',
            }),
          }),
          required: ['api_key'],
        }),
        initialValues: { comment: 'Safe existing note' },
      })
    );
    expect(form.schema.properties.api_key.default).toBeUndefined();
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

  it('keeps the member role alongside the OAuth scope challenge on a thrown UI-tool error', async () => {
    // A scope-less OAuth token throws at the access check, and the catch path
    // emits the `mcp/www_authenticate` challenge. The viewer role must ride
    // along in the SAME `_meta`, merged rather than overwritten, so the app
    // never sees a role-less error result and falls back to a stale role.
    const readlessToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'profile:read',
      })
    ).token;
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: readlessToken,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'scope-challenge-member-role',
        method: 'tools/call',
        params: {
          name: 'render_lobu_view',
          arguments: {
            action: 'render',
            blocks: [{ type: 'text', value: 'scope probe' }],
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: readlessToken,
    });
    const body = await response.json();
    const challenge = body.result?._meta?.['mcp/www_authenticate']?.[0];
    expect(body.result?.isError).toBe(true);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:read"');
    expect(body.result?._meta?.['lobu/member-role']).toBe('owner');
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
        params: { name: 'search_sdk', arguments: { query: 'automations' } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        query: 'automations',
        match_count: expect.any(Number),
        results: expect.any(Array),
      })
    );
    const serializedDiscovery = JSON.stringify(body.result?.structuredContent).toLowerCase();
    for (const retiredTerm of [
      'wat' + 'cher',
      'behav' + 'ior',
      'behav' + 'iour',
    ]) {
      expect(serializedDiscovery).not.toContain(retiredTerm);
    }
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

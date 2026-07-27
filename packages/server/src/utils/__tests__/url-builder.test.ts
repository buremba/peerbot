import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentConversationUrl,
  buildAgentSettingsUrl,
  buildBehaviorSettingsUrl,
  buildBehaviorUrl,
  buildEntityUrl,
  buildProviderConnectUrl,
  buildProviderManagementUrl,
  buildResourcePermalink,
  getPublicWebUrl,
} from '../url-builder';
import {
  HOSTED_UI_FALLBACK_ORIGIN,
  __resetPublicOriginCachesForTests,
  __setLocalFrontendForTests,
} from '../public-origin';
import * as workspaceModule from '../../workspace';

/**
 * Behavior contract for `getPublicWebUrl`:
 *   1. Explicit `baseUrl` argument wins.
 *   2. `PUBLIC_GATEWAY_URL` env wins next.
 *   3. With no local frontend bundled, fall back to the hosted-UI origin
 *      (`HOSTED_UI_FALLBACK_ORIGIN`) so backend-only self-hosters still emit
 *      usable links. The `requestUrl` is only consulted when a local frontend
 *      is present — that's why most tests below assert the fallback even when
 *      a `requestUrl` is supplied.
 */
describe('getPublicWebUrl', () => {
  const originalGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_GATEWAY_URL;
    __resetPublicOriginCachesForTests();
  });

  afterEach(() => {
    if (originalGatewayUrl !== undefined) {
      process.env.PUBLIC_GATEWAY_URL = originalGatewayUrl;
    } else {
      delete process.env.PUBLIC_GATEWAY_URL;
    }
    __resetPublicOriginCachesForTests();
  });

  it('returns explicit baseUrl when provided', () => {
    expect(getPublicWebUrl(undefined, 'https://configured.lobu.com')).toBe(
      'https://configured.lobu.com'
    );
  });

  it('strips trailing slash from baseUrl', () => {
    expect(getPublicWebUrl(undefined, 'https://fallback.lobu.com/')).toBe(
      'https://fallback.lobu.com'
    );
  });

  it('prefers explicit baseUrl over requestUrl', () => {
    expect(getPublicWebUrl('https://request.lobu.com/mcp', 'https://configured.lobu.com')).toBe(
      'https://configured.lobu.com'
    );
  });

  it('prefers PUBLIC_GATEWAY_URL env var when no explicit baseUrl', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://env.lobu.com/lobu';
    expect(getPublicWebUrl('https://request.lobu.com/mcp')).toBe('https://env.lobu.com');
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN when no env, no baseUrl, no local frontend', () => {
    // Pin the precondition: a built packages/owletto/dist on the dev machine
    // (any owletto build, e.g. make review) would otherwise flip
    // hasLocalFrontend() and break the assertion.
    __setLocalFrontendForTests(false);
    expect(getPublicWebUrl(undefined, undefined)).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN even when requestUrl is given (backend-only host)', () => {
    __setLocalFrontendForTests(false);
    expect(getPublicWebUrl('https://request.lobu.com/mcp')).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });
});

// Stub the org-slug lookup so the URL-builder tests assert only URL SHAPE, not
// tenant resolution. A `vi.spyOn` in beforeEach (not a module-level `vi.mock`)
// is required: the server vitest config runs `isolate: false`, so a module-mock
// declared here does NOT apply once an earlier test file has loaded the real
// `../../workspace` module into the shared registry — the spy re-applies on
// every run regardless of load order.
function stubOrgSlug(): void {
  beforeEach(() => {
    vi.spyOn(workspaceModule, 'getWorkspaceProvider').mockReturnValue({
      getOrgSlug: async (orgId: string) =>
        orgId === 'org-1' ? 'acme' : orgId === 'org-special' ? 'acme/team' : null,
    } as unknown as ReturnType<typeof workspaceModule.getWorkspaceProvider>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

describe('buildAgentSettingsUrl', () => {
  stubOrgSlug();
  // Regression: the CTA for provider/model errors ("Connect a provider" /
  // "Choose a model") MUST deep-link to the agent's /settings tab. The bare
  // /agents/<id> route redirects to Chat — the surface the user just failed on
  // — so a missing /settings suffix drops the admin nowhere useful.
  it('deep-links to the agent /settings tab (not the bare, chat-redirecting route)', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com/lobu', 'org-1', 'lobu-builder');
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/settings');
    expect(url?.endsWith('/settings')).toBe(true);
  });

  // WI-0.3 config-prefill: an update proposal's approval CTA appends ?run_id=<id>
  // so the settings form opens the review flow prefilled with the held change.
  it('appends ?run_id when a review run is given', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com/lobu', 'org-1', 'lobu-builder', {
      runId: 42,
    });
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/settings?run_id=42');
  });

  it('omits ?run_id when no review run is given', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com', 'org-1', 'lobu-builder', {});
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/settings');
  });

  // Model-related CTAs ("choose a model") opt into the `#models` fragment so the
  // settings page scrolls to the ordered models allow-list. Per-call, NOT the
  // default: the run-review CTA (?run_id) reviews the whole config form, so the
  // exact-URL assertions above double as the "no fragment unless asked" proof.
  it('appends #models when the caller opts in via modelsAnchor', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com/lobu', 'org-1', 'lobu-builder', {
      modelsAnchor: true,
    });
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/settings#models');
  });

  it('places the fragment after the ?run_id query when both are given', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com', 'org-1', 'lobu-builder', {
      runId: 42,
      modelsAnchor: true,
    });
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/settings?run_id=42#models');
  });

  it('strips the embedded-mode /lobu suffix from the web origin', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com/lobu/', 'org-1', 'my agent/id');
    // agentId is percent-encoded; origin has no /lobu.
    expect(url).toBe('https://app.lobu.com/acme/agents/my%20agent%2Fid/settings');
  });

  it('percent-encodes the workspace slug', async () => {
    const url = await buildAgentSettingsUrl('https://app.lobu.com', 'org-special', 'agent-1');
    expect(url).toBe('https://app.lobu.com/acme%2Fteam/agents/agent-1/settings');
  });

  it('returns null when the org slug cannot be resolved', async () => {
    expect(await buildAgentSettingsUrl('https://app.lobu.com', 'unknown-org', 'a')).toBeNull();
  });

  it('returns null when any required piece is missing', async () => {
    expect(await buildAgentSettingsUrl(undefined, 'org-1', 'a')).toBeNull();
    expect(await buildAgentSettingsUrl('https://x', undefined, 'a')).toBeNull();
    expect(await buildAgentSettingsUrl('https://x', 'org-1', undefined)).toBeNull();
  });
});

describe('buildBehaviorSettingsUrl', () => {
  stubOrgSlug();
  it('deep-links to the Behavior edit route under its owning agent', async () => {
    const url = await buildBehaviorSettingsUrl(
      'https://app.lobu.com/lobu',
      'org-1',
      'lobu-builder',
      7
    );
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/behaviors/7');
  });

  it('appends ?run_id when a review run is given', async () => {
    const url = await buildBehaviorSettingsUrl(
      'https://app.lobu.com/lobu',
      'org-1',
      'lobu-builder',
      7,
      { runId: 42 }
    );
    expect(url).toBe('https://app.lobu.com/acme/agents/lobu-builder/behaviors/7?run_id=42');
  });

  it('accepts a string Behavior id and percent-encodes agent + slug', async () => {
    const url = await buildBehaviorSettingsUrl(
      'https://app.lobu.com',
      'org-special',
      'my agent/id',
      '7'
    );
    expect(url).toBe('https://app.lobu.com/acme%2Fteam/agents/my%20agent%2Fid/behaviors/7');
  });

  it('returns null when the org slug cannot be resolved', async () => {
    expect(
      await buildBehaviorSettingsUrl('https://app.lobu.com', 'unknown-org', 'a', 7)
    ).toBeNull();
  });

  it('returns null when any required piece is missing', async () => {
    expect(await buildBehaviorSettingsUrl(undefined, 'org-1', 'a', 7)).toBeNull();
    expect(await buildBehaviorSettingsUrl('https://x', undefined, 'a', 7)).toBeNull();
    expect(await buildBehaviorSettingsUrl('https://x', 'org-1', undefined, 7)).toBeNull();
    expect(await buildBehaviorSettingsUrl('https://x', 'org-1', 'a', undefined)).toBeNull();
  });
});

describe('buildBehaviorUrl', () => {
  it('builds the canonical Behavior detail route and strips embedded /lobu', () => {
    expect(buildBehaviorUrl('acme/team', 'agent one', 7, 'https://app.lobu.com/lobu')).toBe(
      'https://app.lobu.com/acme%2Fteam/agents/agent%20one/behaviors/7'
    );
  });
});

describe('buildAgentConversationUrl', () => {
  it('builds the canonical transcript route and encodes the conversation id whole', () => {
    expect(
      buildAgentConversationUrl(
        'acme/team',
        'agent one',
        'slack:C1:169.1',
        'https://app.lobu.com/lobu/'
      )
    ).toBe(
      'https://app.lobu.com/acme%2Fteam/agents/agent%20one/conversations/slack%3AC1%3A169.1'
    );
  });
});

describe('buildProviderConnectUrl', () => {
  stubOrgSlug();
  // The "connect a provider" CTA target — distinct from buildAgentSettingsUrl.
  // Its fix is wiring credentials, so it lands on /inference-providers/new, the
  // live connect form, NOT the agent's model settings.
  it('builds the connect-a-provider URL (distinct page from agent settings)', async () => {
    const url = await buildProviderConnectUrl('https://app.lobu.com/lobu', 'org-1');
    expect(url).toBe('https://app.lobu.com/acme/inference-providers/new');
  });

  it('prefills provider + model on the connect form when given', async () => {
    const url = await buildProviderConnectUrl('https://app.lobu.com', 'org-1', {
      provider: 'z-ai',
      model: 'z-ai/glm-5.2',
    });
    expect(url).toBe(
      'https://app.lobu.com/acme/inference-providers/new?provider=z-ai&model=z-ai%2Fglm-5.2'
    );
  });

  it('preserves the preflight reason + agent target', async () => {
    const url = await buildProviderConnectUrl('https://app.lobu.com', 'org-1', {
      provider: 'z-ai',
      model: 'z-ai/glm-5.2',
      reason: 'model_provider_not_connected',
      agentId: 'agent/1',
    });
    expect(url).toBe(
      'https://app.lobu.com/acme/inference-providers/new?provider=z-ai&model=z-ai%2Fglm-5.2&reason=model_provider_not_connected&agentId=agent%2F1'
    );
  });

  it('returns null when org slug or gateway url is missing', async () => {
    expect(await buildProviderConnectUrl(undefined, 'org-1')).toBeNull();
    expect(await buildProviderConnectUrl('https://x', undefined)).toBeNull();
    expect(await buildProviderConnectUrl('https://x', 'unknown-org')).toBeNull();
  });
});

describe('buildProviderManagementUrl', () => {
  stubOrgSlug();

  it('targets the exact existing provider and model', async () => {
    const url = await buildProviderManagementUrl('https://app.lobu.com/lobu', 'org-1', {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
    expect(url).toBe('https://app.lobu.com/acme/infrastructure/models?provider=z-ai&model=glm-5.2');
  });

  it('returns null when org slug or gateway url is missing', async () => {
    expect(await buildProviderManagementUrl(undefined, 'org-1')).toBeNull();
    expect(await buildProviderManagementUrl('https://x', undefined)).toBeNull();
    expect(await buildProviderManagementUrl('https://x', 'unknown-org')).toBeNull();
  });
});

describe('buildEntityUrl', () => {
  it('builds URL with provided baseUrl', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      'https://app.lobu.com'
    );
    expect(url).toBe('https://app.lobu.com/acme/topic/test-topic');
  });

  it('builds relative URL when no base provided', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      undefined
    );
    expect(url).toBe('/acme/topic/test-topic');
  });
});

describe('buildResourcePermalink', () => {
  it('run kind → ?run_ids (survives the supersede chain by construction)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'run', runId: 536620 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?run_ids=536620');
  });

  it('behavior run kind → agent and behavior drill-down scoped to the run', () => {
    expect(
      buildResourcePermalink(
        'acme',
        { kind: 'behavior_run', runId: 536620, agentId: 'agent/one', behaviorId: 42 },
        'https://app.lobu.com'
      )
    ).toBe(
      'https://app.lobu.com/acme/memory?agent=agent%2Fone&behavior=42&run_ids=536620'
    );
  });

  it('event kind → ?content_ids (chain-resolved on read)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'event', eventId: 4309390 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?content_ids=4309390');
  });

  it('feed kind → ?feed_ids (all activity in a channel)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'feed', feedId: 42 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?feed_ids=42');
  });

  it('builds a relative URL when no base is provided', () => {
    expect(buildResourcePermalink('acme', { kind: 'run', runId: 536620 })).toBe(
      '/acme/memory?run_ids=536620'
    );
  });

  it('returns undefined when the org slug is missing (no usable link)', () => {
    expect(buildResourcePermalink(null, { kind: 'run', runId: 1 })).toBeUndefined();
    expect(buildResourcePermalink(undefined, { kind: 'event', eventId: 1 })).toBeUndefined();
  });
});

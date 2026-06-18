// Regression guard: a connector's connection-level `optionsSchema` must NOT
// declare any key that is also feed-scoped (i.e. present in some feed's
// `configSchema.properties`).
//
// The server (splitConfigByFeedScope) treats every feed-config key as
// feed-scoped and REJECTS it on the connection, while `lobu apply` validates
// the connection config against `optionsSchema` (and enforces its `required`).
// If a key lives in both, those two rules contradict and the connector can
// never be created via `apply` — which is exactly the bug this test prevents.
// See packages/server/src/tools/admin/helpers/feed-helpers.ts and
// packages/cli/src/commands/_lib/apply/desired-state.ts.

import { mock, test } from 'bun:test';
import { readdirSync } from 'node:fs';

// Superset stub covering every symbol any connector imports from the SDK, so
// each connector module imports without the browser/runtime stack. We only read
// the static `.definition`, never run sync/auth.
mock.module('@lobu/connector-sdk', () => {
  const fn = () =>
    new Proxy(function stub() {}, { apply: () => ({}), construct: () => ({}) });
  return {
    ConnectorRuntime: class {},
    BridgeOnlyConnector: class {},
    HttpStatusError: class extends Error {},
    IDENTITY: {},
    calculateEngagementScore: () => 0,
    acquireBrowser: fn(),
    browserNetworkSync: fn(),
    captureErrorArtifacts: fn(),
    createHttpClient: fn(),
    extensionDomScrape: fn(),
    extensionNetworkSync: fn(),
    launchBrowser: fn(),
    paginateByCursor: fn(),
    paginateByOffset: fn(),
    requireBearerClient: fn(),
    ActionContext: {},
    ActionResult: {},
    AuthContext: {},
    AuthResult: {},
    CdpPage: {},
    ChromeActionDispatcher: {},
    ConnectorDefinition: {},
    EventEnvelope: {},
    HttpClient: {},
    QueryContext: {},
    QueryResult: {},
    SyncContext: {},
    SyncResult: {},
  };
});

test('no connector optionsSchema key is also feed-scoped', async () => {
  const dir = new URL('..', import.meta.url).pathname;
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.includes('utils') && f !== 'index.ts'
  );
  const offenders: string[] = [];
  let checked = 0;
  for (const f of files) {
    let mod: { default?: new () => { definition?: Record<string, unknown> } };
    try {
      mod = await import(`../${f}`);
    } catch {
      continue;
    }
    const Cls = mod.default;
    if (typeof Cls !== 'function') continue;
    let def: Record<string, unknown> | undefined;
    try {
      def = new Cls().definition;
    } catch {
      continue;
    }
    if (!def) continue;
    checked++;
    const opt = def.optionsSchema as { properties?: Record<string, unknown> } | undefined;
    if (!opt?.properties) continue;
    const feeds = (def.feeds ?? {}) as Record<
      string,
      { configSchema?: { properties?: Record<string, unknown> } }
    >;
    const feedScoped = new Set<string>();
    for (const fd of Object.values(feeds))
      for (const k of Object.keys(fd?.configSchema?.properties ?? {})) feedScoped.add(k);
    const overlap = Object.keys(opt.properties).filter((k) => feedScoped.has(k));
    if (overlap.length) {
      offenders.push(
        `${String((def as { key?: string }).key ?? f)}: optionsSchema declares feed-scoped key(s) [${overlap.join(', ')}] — move them to the feed's configSchema only`
      );
    }
  }
  if (checked < 10) throw new Error(`only ${checked} connectors loaded — mock likely incomplete`);
  if (offenders.length) throw new Error(`Connector config scope conflicts:\n  ${offenders.join('\n  ')}`);
});

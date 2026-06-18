// Shared @lobu/connector-sdk mock for connector unit tests.
//
// mock.module replaces the WHOLE module and bun shares the mock registry
// across files in a run, so every connector test that stubs the SDK must
// expose the same superset of symbols regardless of file order. This is the
// single source for that superset — `mock.module('@lobu/connector-sdk',
// connectorSdkMock)` in each test file.
//
// The SDK pulls in playwright; stubbing lets the pure connector logic be
// imported without the browser stack. The runtime-only symbols throw if a
// test actually reaches them; extensionDomScrape is faithfully re-implemented
// so the home-feed path exercises the same dispatch shape (the real helper has
// its own tests in packages/connector-sdk).

interface DomScrapeOpts {
  dispatcher: {
    // biome-ignore lint/suspicious/noExplicitAny: stub dispatcher return
    dispatch: (action: string, input: Record<string, unknown>) => Promise<any>;
  };
  url: string;
  config: Record<string, unknown>;
  parseRows: (rows: Array<Record<string, unknown>>) => unknown[];
  allowedOrigins: string[];
  persistent?: boolean;
  focus?: boolean;
}

export function connectorSdkMock() {
  const notUsed = (name: string) => () => {
    throw new Error(`${name} is not used in connector unit tests`);
  };
  return {
    acquireBrowser: notUsed('acquireBrowser'),
    captureErrorArtifacts: notUsed('captureErrorArtifacts'),
    extensionNetworkSync: notUsed('extensionNetworkSync'),
    createHttpClient: notUsed('createHttpClient'),
    requireBearerClient: notUsed('requireBearerClient'),
    paginateByCursor: notUsed('paginateByCursor'),
    paginateByOffset: notUsed('paginateByOffset'),
    ConnectorRuntime: class {},
    calculateEngagementScore: () => 0,
    extensionDomScrape: async (opts: DomScrapeOpts) => {
      const observation = await opts.dispatcher.dispatch('navigate', {
        cs_scrape: true,
        persistent: opts.persistent ?? true,
        focus: opts.focus ?? true,
        url: opts.url,
        scrape_config: opts.config,
        allowed_origins: opts.allowedOrigins,
      });
      const result = observation?.result;
      const items = opts.parseRows(result?.rows ?? []);
      return {
        items,
        loggedIn: result?.loggedIn !== false,
        count: result?.count ?? items.length,
        host: result?.host,
        landedUrl: result?.landedUrl,
      };
    },
  };
}

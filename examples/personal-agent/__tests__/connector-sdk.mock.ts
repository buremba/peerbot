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
// test actually reaches them; extensionDomScrape and the paginateBy* generators
// are faithfully re-implemented so connectors that delegate their sync loops
// exercise the real paging semantics (the real helpers have their own tests in
// packages/connector-sdk). They are re-implemented inline rather than imported
// from connector-sdk/src because this mock is copied verbatim into the cli's
// dist/ for the packaged-connector test run, where that cross-package source
// path does not resolve.

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

// Faithful copies of the SDK's pure pagination generators (no browser stack).
// Kept byte-for-byte in step with packages/connector-sdk/src/pagination.ts.
async function* paginateByCursor<T, C = string>(
  fetchPage: (
    cursor: C | null
  ) => Promise<{ items: T[]; nextCursor: C | null | undefined }>,
  options: {
    maxPages?: number;
    initialCursor?: C | null;
    delayMs?: number;
  } = {}
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let cursor: C | null = options.initialCursor ?? null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, nextCursor } = await fetchPage(cursor);
    yield items;
    if (nextCursor === null || nextCursor === undefined) return;
    cursor = nextCursor;
  }
}

async function* paginateByOffset<T>(
  fetchPage: (
    offset: number,
    pageSize: number
  ) => Promise<{ items: T[]; hasMore: boolean }>,
  options: {
    pageSize: number;
    maxPages?: number;
    startOffset?: number;
    delayMs?: number;
  }
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, hasMore } = await fetchPage(offset, options.pageSize);
    yield items;
    if (!hasMore) return;
    offset += options.pageSize;
  }
}

export function connectorSdkMock() {
  const notUsed = (name: string) => () => {
    throw new Error(`${name} is not used in connector unit tests`);
  };
  return {
    acquireBrowser: notUsed("acquireBrowser"),
    captureErrorArtifacts: notUsed("captureErrorArtifacts"),
    extensionNetworkSync: notUsed("extensionNetworkSync"),
    // Connectors create their HTTP client as a class field at construction, so a
    // throwing stub would break `new XConnector()`. Return an inert client whose
    // network methods throw only IF actually called — tests that exercise a
    // request path override `connector.http` / `connector.requestJson` first.
    createHttpClient: () => ({
      json: notUsed("http.json"),
      request: notUsed("http.request"),
    }),
    requireBearerClient: notUsed("requireBearerClient"),
    paginateByCursor,
    paginateByOffset,
    ConnectorRuntime: class {},
    calculateEngagementScore: () => 0,
    IDENTITY: {
      PHONE: "phone",
      EMAIL: "email",
      WA_JID: "wa_jid",
      SLACK_USER_ID: "slack_user_id",
      GITHUB_LOGIN: "github_login",
      GITHUB_USER_ID: "github_user_id",
      GITHUB_REPO_ID: "github_repo_id",
      GITHUB_REPO_FULL_NAME: "github_repo_full_name",
      AUTH_USER_ID: "auth_user_id",
      GOOGLE_CONTACT_ID: "google_contact_id",
    },
    extensionDomScrape: async (opts: DomScrapeOpts) => {
      const observation = await opts.dispatcher.dispatch("navigate", {
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

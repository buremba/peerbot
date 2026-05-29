/**
 * Unit tests for extensionDomScrape. Drives the helper with a stub
 * ChromeActionDispatcher that records the dispatched action + input and
 * returns a canned cs_scrape observation.
 */

import { describe, expect, test } from 'bun:test';
import type { ExtensionScrapeObservation } from '../extension-dom-scrape.js';
import { extensionDomScrape } from '../extension-dom-scrape.js';
import type { ChromeActionDispatcher } from '../extension-network.js';

interface DispatchLog {
  action: string;
  input: Record<string, unknown>;
}

function makeDispatcher(observation: ExtensionScrapeObservation): {
  dispatcher: ChromeActionDispatcher;
  log: DispatchLog[];
} {
  const log: DispatchLog[] = [];
  const dispatcher: ChromeActionDispatcher = {
    dispatch: async (action: string, input: Record<string, unknown>) => {
      log.push({ action, input });
      return observation as never;
    },
  };
  return { dispatcher, log };
}

describe('extensionDomScrape', () => {
  test('dispatches a single cs_scrape navigate with the config + allowlist', async () => {
    const { dispatcher, log } = makeDispatcher({
      tab_id: 7,
      cs_scrape: true,
      result: {
        loggedIn: true,
        count: 2,
        host: 'www.example.com',
        rows: [{ id: 'a' }, { id: 'b' }],
      },
    });

    const config = { rowSelector: 'div.row', scroll: { max: 4 } };
    const res = await extensionDomScrape<{ id?: string }>({
      dispatcher,
      url: 'https://www.example.com/feed/',
      config,
      parseRows: (rows) => rows as { id?: string }[],
      allowedOrigins: ['example.com', '*.example.com'],
    });

    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('navigate');
    expect(log[0].input.cs_scrape).toBe(true);
    expect(log[0].input.persistent).toBe(true);
    expect(log[0].input.focus).toBe(true);
    expect(log[0].input.url).toBe('https://www.example.com/feed/');
    expect(log[0].input.scrape_config).toBe(config);
    expect(log[0].input.allowed_origins).toEqual(['example.com', '*.example.com']);

    expect(res.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(res.loggedIn).toBe(true);
    expect(res.count).toBe(2);
    expect(res.host).toBe('www.example.com');
  });

  test('treats absent loggedIn as logged in and defaults count to item length', async () => {
    const { dispatcher } = makeDispatcher({ result: { rows: [{ id: 'x' }] } });
    const res = await extensionDomScrape<{ id?: string }>({
      dispatcher,
      url: 'https://www.example.com/feed/',
      config: {},
      parseRows: (rows) => rows as { id?: string }[],
      allowedOrigins: ['example.com'],
    });
    expect(res.loggedIn).toBe(true);
    expect(res.count).toBe(1);
    expect(res.items).toHaveLength(1);
  });

  test('surfaces loggedIn:false', async () => {
    const { dispatcher } = makeDispatcher({
      result: { loggedIn: false, rows: [] },
    });
    const res = await extensionDomScrape<{ id?: string }>({
      dispatcher,
      url: 'https://www.example.com/feed/',
      config: {},
      parseRows: (rows) => rows as { id?: string }[],
      allowedOrigins: ['example.com'],
    });
    expect(res.loggedIn).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.count).toBe(0);
  });

  test('honors persistent/focus overrides and handles a missing result envelope', async () => {
    const { dispatcher, log } = makeDispatcher({});
    const res = await extensionDomScrape<{ id?: string }>({
      dispatcher,
      url: 'https://www.example.com/feed/',
      config: {},
      parseRows: (rows) => rows as { id?: string }[],
      allowedOrigins: ['example.com'],
      persistent: false,
      focus: false,
    });
    expect(log[0].input.persistent).toBe(false);
    expect(log[0].input.focus).toBe(false);
    // No `result` → empty rows, logged-in by default, count 0.
    expect(res.items).toEqual([]);
    expect(res.loggedIn).toBe(true);
    expect(res.count).toBe(0);
  });
});

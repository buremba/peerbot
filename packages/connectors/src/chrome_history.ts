/**
 * Chrome History Connector — Owletto for Chrome only.
 *
 * Opt-in ambient feed. The Chrome extension advertises capability
 * `browser.history` when the user grants the `history` Chrome permission
 * via the sidepanel Permissions panel; the gateway then auto-wires this
 * connector to the paired chrome-extension device.
 *
 * Emits one event per page load (URL, title, visit time, transition type).
 * The backfill feed seeds with up to 90 days of history on first sync; the
 * live feed streams `history.onVisited` thereafter.
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in
 * apps/chrome/feeds-history.js in the extension.
 */

import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'chrome.history runs only on a worker advertising capability "browser.history" (Owletto for Chrome with history permission granted).';

export default class ChromeHistoryConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'chrome.history',
    name: 'Chrome history',
    description:
      "Every page the user visits in their paired Chrome profile, with visit time + transition type. Opt-in — requires the user to grant the extension's optional `history` permission.",
    version: '0.1.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.history',
    runtime: { platforms: ['chrome-extension'] as unknown as ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      visits: {
        key: 'visits',
        name: 'Visits',
        description:
          'One event per page visit. Backfills ~90 days on first sync (chrome.history.search), then streams new visits via the chrome.history.onVisited listener.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          page_visit: {
            description: 'One row per visit observed.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'url', 'visit_time'],
              properties: {
                source: { type: 'string', const: 'chrome_history' },
                origin_id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                title: { type: 'string' },
                visit_time: { type: 'string', format: 'date-time' },
                transition_type: {
                  description:
                    'How the user got to the page: link, typed, auto_bookmark, auto_subframe, manual_subframe, generated, start_page, form_submit, reload, keyword, keyword_generated.',
                  type: 'string',
                },
                visit_id: { type: 'integer' },
                visit_count: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  };
}

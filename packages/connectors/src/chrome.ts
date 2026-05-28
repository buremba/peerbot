/**
 * Chrome Connector — Owletto for Chrome only.
 *
 * One connector per paired Chrome profile. The cloud-side definition is
 * pure metadata; all execution happens in the extension's service worker
 * (apps/chrome/background.js: dispatchToolRun) against the user's signed-in
 * Chrome via chrome.debugger + chrome.scripting + chrome.tabs.
 *
 * Surface:
 *
 *   feeds.open_tabs
 *     Auto-wired snapshot feed. The extension emits one event per open tab
 *     each sync cycle. Cheap and read-only.
 *
 *   actions.navigate
 *     Page.navigate the target tab (default: a fresh background tab; opt
 *     out via open_in_new_tab=false) to `url`.
 *
 *   actions.get_accessibility_tree
 *     Inject the bundled accessibility-tree.js content script and return a
 *     structured snapshot of the visible interactive nodes, each with a
 *     stable {frame_id, document_epoch, ref_id} that subsequent
 *     click_ref/type_ref calls can target. Sensitive fields (password,
 *     one-time-code, credit-card autocomplete) are redacted in the page
 *     before the snapshot leaves it.
 *
 *   actions.click_ref / actions.type_ref
 *     Act on a ref returned by get_accessibility_tree, in the same tab,
 *     using chrome.debugger Input.dispatchMouseEvent / dispatchKeyEvent /
 *     insertText. Refs become stale on navigation or DOM replacement; the
 *     extension surfaces a clear error and the caller re-snapshots.
 *
 *   actions.wait_for_selector
 *     Poll the page for a CSS selector via Runtime.evaluate. Returns when
 *     it appears or rejects on timeout (default 10s).
 *
 *   actions.screenshot
 *     Page.captureScreenshot. PNG, base64-encoded.
 *
 *   actions.evaluate
 *     Runtime.evaluate(expression). Returns the JSON-serialised result.
 *     Last-resort escape hatch — prefer ref-based actions because the
 *     script string is harder to audit.
 *
 * The connector author writes a normal server-side sync() that sequences
 * these actions through `ctx.chrome.<tool>(args)` (helper added in a
 * later PR — for v1 the actions are reachable directly via the run
 * scheduling API). No bespoke executor code lives in the extension; new
 * connectors compose existing tools.
 *
 * URL allowlist: each connector that runs on top of this dispatcher
 * declares `allowedOrigins` on its own definition. The extension refuses
 * any tool call whose target URL is outside the allowlist.
 *
 * Required worker capability is `browser.debugger`.
 *
 * Cloud-side `sync()` / `execute()` throw — actual work happens in the
 * extension's service worker.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'chrome runs only on a worker advertising capability "browser.debugger" (Owletto for Chrome).';

const tabIdSchema = {
  type: 'integer',
  description: 'Tab to act on. Defaults to the run-scoped scratch tab.',
} as const;

const refIdSchema = {
  type: 'object',
  required: ['document_epoch', 'ref_id'],
  properties: {
    document_epoch: { type: 'integer' },
    ref_id: { type: 'integer' },
  },
  description:
    'Element reference returned by a prior get_accessibility_tree call on the same tab + document. frame_id is reserved for future iframe support; v1 dispatches against the main frame.',
} as const;

export default class ChromeConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'chrome',
    name: 'Chrome',
    description:
      'Paired Chrome profile. Tab snapshots + a fixed set of typed browser actions (navigate, click, type, wait, screenshot, accessibility snapshot, evaluate) that connectors compose without shipping per-connector code into the extension.',
    version: '0.2.0',
    faviconDomain: 'google.com',
    requiredCapability: 'browser.debugger',
    runtime: { platforms: ['chrome-extension'] as unknown as ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      open_tabs: {
        key: 'open_tabs',
        name: 'Open tabs',
        description: 'Snapshot of the tabs currently open in this Chrome profile.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          tab_snapshot: {
            description: 'One row per tab observed in the active poll cycle.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'url'],
              properties: {
                source: { type: 'string', const: 'chrome_tabs' },
                origin_id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                title: { type: 'string' },
                window_id: { type: 'integer' },
                active: { type: 'boolean' },
              },
            },
          },
        },
      },
      tab_events: {
        key: 'tab_events',
        name: 'Tab events',
        description:
          'Live stream of tab creates / closes / URL changes / focus changes. Each event has a timestamp, so this is the lossless "browsing timeline" companion to the open_tabs snapshot. No extra permission required (baseline `tabs`).',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          tab_event: {
            description:
              'One row per tab lifecycle event. event_type is one of: created, removed, updated, activated.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'event_type'],
              properties: {
                source: { type: 'string', const: 'chrome_tab_events' },
                origin_id: { type: 'string' },
                event_type: {
                  enum: ['created', 'removed', 'updated', 'activated'],
                },
                tab_id: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                window_id: { type: 'integer' },
                from_url: {
                  type: 'string',
                  description: 'For updated events, the URL the tab was on before the change.',
                },
              },
            },
          },
        },
      },
    },
    actions: {
      navigate: {
        key: 'navigate',
        name: 'Navigate',
        description: 'Open a URL in a fresh background tab (default) or an existing tab.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            tab_id: tabIdSchema,
            open_in_new_tab: {
              type: 'boolean',
              description: 'Default true. Opt out for active-tab control.',
            },
            wait_for_load: {
              type: 'boolean',
              description:
                'Wait for Page.frameStoppedLoading on the main frame before returning. Default true.',
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            tab_id: { type: 'integer' },
            current_url: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
      get_accessibility_tree: {
        key: 'get_accessibility_tree',
        name: 'Get accessibility tree',
        description:
          'Return a structured snapshot of the visible interactive elements on the page, with stable refs for click_ref/type_ref. Sensitive fields are redacted.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          properties: {
            tab_id: tabIdSchema,
            filter: {
              enum: ['interactive', 'visible', 'all'],
              description: 'Default "interactive". "all" is for debugging only.',
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            document_epoch: { type: 'integer' },
            current_url: { type: 'string' },
            title: { type: 'string' },
            tree: { type: 'array' },
          },
        },
      },
      click_ref: {
        key: 'click_ref',
        name: 'Click element by ref',
        description:
          'Dispatch a mouse click on the element identified by a ref from a prior accessibility snapshot of the same tab + document.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['ref'],
          properties: {
            ref: refIdSchema,
            tab_id: tabIdSchema,
            button: {
              enum: ['left', 'right', 'middle'],
              description: 'Default "left".',
            },
            click_count: {
              type: 'integer',
              minimum: 1,
              maximum: 3,
              description: 'Default 1. Use 2 for double-click, 3 for triple-click.',
            },
          },
        },
      },
      type_ref: {
        key: 'type_ref',
        name: 'Type into element by ref',
        description:
          'Focus the element identified by a ref and dispatch keystrokes to enter the given text. Existing value is replaced by default.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['ref', 'text'],
          properties: {
            ref: refIdSchema,
            tab_id: tabIdSchema,
            text: { type: 'string' },
            clear_first: {
              type: 'boolean',
              description: 'Default true. Selects all + deletes before typing.',
            },
          },
        },
      },
      wait_for_selector: {
        key: 'wait_for_selector',
        name: 'Wait for selector',
        description:
          'Poll the page for the first match of a CSS selector and return when it appears.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['selector'],
          properties: {
            selector: { type: 'string' },
            tab_id: tabIdSchema,
            timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 60_000,
              description: 'Default 10000.',
            },
          },
        },
      },
      screenshot: {
        key: 'screenshot',
        name: 'Screenshot',
        description: 'Capture the visible viewport as a PNG.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          properties: {
            tab_id: tabIdSchema,
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            data_url: {
              type: 'string',
              description: 'data:image/png;base64,... — caller decodes.',
            },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
      },
      close_tab: {
        key: 'close_tab',
        name: 'Close tab',
        description:
          'Close a tab the extension created for this connector. Required at the end of any multi-step session — tabs the extension owned across navigate / get_accessibility_tree / click_ref / etc. are NOT auto-disposed (that would break the natural flow). A reaper closes orphaned owned tabs after 30 minutes.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['tab_id'],
          properties: { tab_id: { type: 'integer' } },
        },
      },
      network_intercept_start: {
        key: 'network_intercept_start',
        name: 'Start network interception',
        description:
          'Attach CDP Network and start buffering response bodies whose URL matches one of `patterns`. Returns a `session_id` the caller uses with drain/stop. Idempotent on resume — passing the same `session_id` is a no-op after a service-worker eviction. Survives SW eviction (buffer persisted to chrome.storage.session).',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['patterns'],
          properties: {
            tab_id: tabIdSchema,
            session_id: {
              type: 'string',
              description: 'Reuse an existing session id. Mints a fresh one when omitted.',
            },
            patterns: {
              type: 'array',
              minItems: 1,
              items: {
                oneOf: [
                  { type: 'string', description: 'URL glob (** = any path; * = path segment).' },
                  {
                    type: 'object',
                    required: ['regex'],
                    properties: {
                      regex: { type: 'string' },
                      flags: { type: 'string' },
                    },
                    description: 'RegExp serialized for the wire.',
                  },
                ],
              },
              description:
                'URL patterns to capture. Matched against response.url at receive time.',
            },
            max_buffer_responses: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              description: 'FIFO buffer cap per session. Default 100.',
            },
            max_body_bytes: {
              type: 'integer',
              minimum: 1024,
              maximum: 10 * 1024 * 1024,
              description: 'Per-response body cap. Bodies above are truncated. Default 1 MiB.',
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            tab_id: { type: 'integer' },
            resumed: { type: 'boolean' },
          },
        },
      },
      network_intercept_drain: {
        key: 'network_intercept_drain',
        name: 'Drain buffered network responses',
        description:
          'Return all buffered intercepted responses for a session, atomically clearing the buffer.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['session_id'],
          properties: {
            session_id: { type: 'string' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            drained: { type: 'integer' },
            missing: { type: 'boolean' },
            responses: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  status: { type: 'integer' },
                  mime: { type: 'string' },
                  body: { type: 'string' },
                  base64_encoded: { type: 'boolean' },
                  truncated: { type: 'boolean' },
                  ts: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      network_intercept_stop: {
        key: 'network_intercept_stop',
        name: 'Stop network interception',
        description:
          'Remove the CDP listener for the session and delete its buffer. Detaches the debugger when this is the last live session on the tab.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['session_id'],
          properties: {
            session_id: { type: 'string' },
          },
        },
      },
      evaluate: {
        key: 'evaluate',
        name: 'Evaluate JS',
        description:
          'Last-resort escape hatch: run a JS expression with Runtime.evaluate and return the JSON-serialised result. Prefer ref-based actions when possible — scripts are harder to audit.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['expression'],
          properties: {
            expression: { type: 'string' },
            tab_id: tabIdSchema,
            await_promise: {
              type: 'boolean',
              description: 'Default true.',
            },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            value: {},
            exception: { type: 'string' },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}

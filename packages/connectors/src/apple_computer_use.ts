import { BridgeOnlyConnector, type ConnectorDefinition } from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'apple.computer_use runs only on a macOS device worker advertising capability "computer_use" (Lobu for Mac with Screen Recording/Accessibility access).';

const appTarget = {
  type: 'string',
  description: 'Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.',
} as const;

const snapshotId = {
  type: 'string',
  description: 'Snapshot id returned by observe/screenshot/inspect. Use this with element ids like elem_12.',
} as const;

const windowTarget = {
  type: 'object',
  properties: {
    app: appTarget,
    window_id: { type: 'integer', description: 'CoreGraphics window id.' },
    window_index: { type: 'integer', description: '0-based window index within app.' },
    window_title: { type: 'string', description: 'Substring of target window title.' },
  },
  additionalProperties: false,
} as const;

const baseOutput = {
  type: 'object',
  additionalProperties: true,
} as const;

export default class AppleComputerUseConnector extends BridgeOnlyConnector {
  constructor() {
    super(BRIDGE_ONLY);
  }

  readonly definition: ConnectorDefinition = {
    key: 'apple.computer_use',
    name: 'Mac Computer Use',
    description:
      'Observe and control this Mac through Lobu for Mac. Uses native macOS Screen Recording/Accessibility via embedded Peekaboo automation. Screenshots/UI trees stay on-device until an explicit action returns them.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'computer_use',
    runtime: { platforms: ['macos'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
    actions: {
      permissions: {
        key: 'permissions',
        name: 'Check permissions',
        description: 'Return Screen Recording, Accessibility, and Event Synthesizing permission status for this Mac.',
        requiresApproval: false,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: baseOutput,
      },
      list_apps: {
        key: 'list_apps',
        name: 'List running apps',
        description: 'List running macOS applications visible to the automation layer.',
        requiresApproval: false,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: baseOutput,
      },
      list_windows: {
        key: 'list_windows',
        name: 'List windows',
        description: 'List windows for an app, or the frontmost app when app is omitted.',
        requiresApproval: false,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          type: 'object',
          properties: { app: appTarget, include_offscreen: { type: 'boolean', default: false } },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      screenshot: {
        key: 'screenshot',
        name: 'Take screenshot',
        description: 'Capture a screen/window/frontmost app and return PNG bytes as base64 plus metadata.',
        requiresApproval: false,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            mode: { enum: ['frontmost', 'screen', 'window'], default: 'frontmost' },
            app: appTarget,
            window_id: { type: 'integer' },
            screen_index: { type: 'integer' },
            retina: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      observe: {
        key: 'observe',
        name: 'Observe UI',
        description:
          'Capture the target and inspect its accessibility tree. Returns screenshot metadata, optional PNG base64, UI elements, and a snapshot_id for later element-targeted actions.',
        requiresApproval: false,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            target: windowTarget,
            include_screenshot: { type: 'boolean', default: true },
            include_image_base64: { type: 'boolean', default: false },
            max_elements: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      click: {
        key: 'click',
        name: 'Click',
        description: 'Click an element id, query, or coordinates. Defaults to background/process-targeted delivery when possible.',
        requiresApproval: true,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            element_id: { type: 'string', description: 'Element id from observe, e.g. elem_12.' },
            query: { type: 'string', description: 'Accessible label/text query to click.' },
            x: { type: 'number' },
            y: { type: 'number' },
            click_type: { enum: ['single', 'double', 'right'], default: 'single' },
            snapshot_id: snapshotId,
            app: appTarget,
            window_id: { type: 'integer' },
            foreground: { type: 'boolean', default: false },
          },
          additionalProperties: false,
          anyOf: [
            { required: ['element_id'] },
            { required: ['query'] },
            { required: ['x', 'y'] },
          ],
        },
        outputSchema: baseOutput,
      },
      type_text: {
        key: 'type_text',
        name: 'Type text',
        description: 'Type text into the current focus or a target element. Prefer paste_text for long text.',
        requiresApproval: true,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            target: { type: 'string', description: 'Optional element id from observe.' },
            snapshot_id: snapshotId,
            app: appTarget,
            clear_existing: { type: 'boolean', default: false },
            delay_ms: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
            press_return: { type: 'boolean', default: false },
            foreground: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      paste_text: {
        key: 'paste_text',
        name: 'Paste text',
        description: 'Set clipboard, paste text, then restore the previous clipboard contents. More reliable than synthetic typing.',
        requiresApproval: true,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            app: appTarget,
            restore_delay_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 150 },
            foreground: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      hotkey: {
        key: 'hotkey',
        name: 'Press hotkey',
        description: 'Press a keyboard shortcut such as cmd,l or cmd,shift,t.',
        requiresApproval: true,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['keys'],
          properties: {
            keys: { type: 'string', description: 'Comma/plus/space separated key combo, e.g. cmd,l.' },
            app: appTarget,
            hold_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 50 },
            foreground: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      move_mouse: {
        key: 'move_mouse',
        name: 'Move mouse',
        description: 'Move the mouse cursor to screen coordinates.',
        requiresApproval: true,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['x', 'y'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            duration_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 0 },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      scroll: {
        key: 'scroll',
        name: 'Scroll',
        description: 'Scroll up/down/left/right at the current pointer or target element.',
        requiresApproval: true,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['direction'],
          properties: {
            direction: { enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'integer', minimum: 1, maximum: 10000, default: 5 },
            target: { type: 'string' },
            snapshot_id: snapshotId,
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
      focus_window: {
        key: 'focus_window',
        name: 'Focus window',
        description: 'Bring a window/application to the foreground.',
        requiresApproval: true,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: { type: 'object', properties: windowTarget.properties, additionalProperties: false },
        outputSchema: baseOutput,
      },
      launch_app: {
        key: 'launch_app',
        name: 'Launch app',
        description: 'Launch an application by name or bundle id.',
        requiresApproval: true,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          required: ['app'],
          properties: {
            app: appTarget,
            bundle_id: { type: 'string' },
            activate: { type: 'boolean', default: true },
            wait_until_ready: { type: 'boolean', default: false },
          },
          additionalProperties: false,
        },
        outputSchema: baseOutput,
      },
    },
  };
}

/**
 * Device manifests the connector-worker daemon declares on poll, keyed by
 * platform. A headless device (server/VM/pod) advertises the os.shell
 * connector so an org can create a connection pinned to it and run shell
 * commands (executed by the bundled os.shell connector via bash -lc).
 */

/**
 * os.shell manifest for headless platforms. Mirrors the macOS manifest's
 * run action (packages/owletto/apps/mac/.../os_shell.json) but targets
 * linux, where the connector-worker daemon (not a native bridge) serves it.
 */
export const HEADLESS_OS_SHELL_MANIFEST: Record<string, unknown> = {
  key: 'os.shell',
  version: '0.1.0',
  name: 'Shell',
  description:
    'Run shell commands on this device through Lobu. Returns structured stdout/stderr/exit_code. Commands run in the device\'s real environment (host PATH, files) - gate with approval.',
  required_capability: 'os.shell',
  runtime: { platforms: ['headless'] },
  auth_schema: { methods: [{ type: 'none' }] },
  feeds_schema: {},
  actions_schema: {
    run: {
      key: 'run',
      kind: 'write',
      name: 'Run command',
      description:
        'Run a shell command on the device and return stdout, stderr, and exit_code. Executes through `bash -lc`, so pipes, redirects, and && chains work. Prefer one focused command per call.',
      requiresApproval: true,
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
          },
          cwd: { type: 'string' },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 300000, default: 60000 },
          stdin: { type: 'string', maxLength: 1000000 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exit_code: { type: 'integer' },
          success: { type: 'boolean' },
          timed_out: { type: 'boolean' },
          duration_ms: { type: 'integer' },
        },
      },
    },
  },
};

/** Manifests a device daemon declares, keyed by platform. */
export const DEVICE_MANIFESTS_BY_PLATFORM: Record<string, unknown[]> = {
  headless: [HEADLESS_OS_SHELL_MANIFEST],
};
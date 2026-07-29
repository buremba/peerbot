/**
 * pi resource loader with filesystem discovery turned off.
 *
 * pi's `DefaultResourceLoader` auto-discovers extensions, prompt templates,
 * skills, themes, context files and SYSTEM.md from `cwd` and `agentDir`, all
 * enabled by default. Those are the right defaults for a developer running pi
 * in their own repo. They are the wrong defaults for us: our `cwd` is the
 * agent's workspace — written to by the agent's own `write`/`bash` tools, and
 * kept across runs for the pod's lifetime (nothing removes it; the workspaces
 * volume is pod-local, not a PVC) — so each of those paths is agent-controlled
 * input to the NEXT run:
 *
 * - `<cwd>/.pi/extensions/*.{ts,js}` are `jiti.import`ed and EXECUTED inside the
 *   worker process, bypassing the bash command policy and the `buildAgentEnv`
 *   environment allowlist entirely.
 * - `<cwd>/.pi/prompts/*.md` replace a user message beginning with `/<name>`.
 * - `<cwd>/.pi/SYSTEM.md` replaces the whole system prompt; `APPEND_SYSTEM.md`
 *   appends to it. Neither is covered by a `no*` flag — only by the overrides
 *   below.
 * - `<cwd>/.pi/skills`, the ancestor `.agents/skills` walk (shared by every
 *   conversation under one workspace root), and `AGENTS.md`/`CLAUDE.md` all
 *   feed the prompt.
 *
 * Everything Lobu wants the agent to have — skills, platform/network
 * instructions, MCP servers — arrives from the gateway as session context, not
 * from the workspace filesystem. So all discovery is off.
 *
 * `agentDir` is pinned to a fixed empty directory rather than left to default
 * (`~/.pi/agent`): otherwise whatever happens to be installed in the image's or
 * developer's home leaks into every agent's prompt, which makes the prompt a
 * function of the host rather than of the agent's configuration. `HOME` is
 * itself pinned to the workspace volume for the worker, so the default would
 * resolve inside the tree this module exists to keep out of resolution.
 *
 * This configures pi's own loader rather than substituting a stub implementing
 * `ResourceLoader`, because `extensionFactories` (in-process extension
 * registration, the supported per-turn hook) is only reachable through
 * `DefaultResourceLoader` — `loadExtensionFromFactory` is not exported from the
 * package root. `noExtensions` filters DISCOVERED extension paths only, so
 * in-process factories still load alongside these flags.
 */
import * as path from "node:path";
import {
  DefaultResourceLoader,
  type SettingsManager,
} from "@mariozechner/pi-coding-agent";

/**
 * Fixed, Lobu-owned pi agent directory. Deliberately neither the agent's
 * workspace nor the host default, so resource resolution can never depend on
 * either.
 *
 * It is a path that does not exist, and is never created. With every discovery
 * flag off, pi only ever `existsSync`-probes `<agentDir>/{extensions,skills,
 * prompts,themes}` and `<agentDir>/AGENTS.md`, so a missing directory is the
 * strongest available form of "empty" and needs no writable location.
 *
 * `os.tmpdir()` is deliberately NOT the base: it is env-derived
 * (TMPDIR/TMP/TEMP), and the gateway pins the worker's `TMPDIR` to
 * `/workspace/.tmp` — inside the very volume this module keeps out of resource
 * resolution, and a path that cannot be created at all when the worker runs
 * embedded on a developer or CI host (`EACCES: mkdir '/workspace'`).
 */
const LOBU_PI_AGENT_DIR = path.join(path.sep, "nonexistent", "lobu-pi-agent");

export async function createLobuResourceLoader(options: {
  cwd: string;
  settingsManager: SettingsManager;
}): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: LOBU_PI_AGENT_DIR,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // The `no*` flags do not cover the system-prompt files. These overrides are
    // what stop `<cwd>/.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` being picked
    // up. Returning undefined/[] leaves pi to build its own base prompt exactly
    // as before: this module changes what is DISCOVERED, not what the prompt
    // says.
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });

  await loader.reload();
  return loader;
}

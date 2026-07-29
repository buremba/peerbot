/**
 * A pi resource loader that reads nothing from disk.
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
 *   appends to it.
 * - `<cwd>/.pi/skills`, the ancestor `.agents/skills` walk (shared by every
 *   conversation under one workspace root), and `AGENTS.md`/`CLAUDE.md` all
 *   feed the prompt.
 *
 * `DefaultResourceLoader`'s suppression options would leave the property
 * resting on several flags and overrides, and they only discard results AFTER
 * `reload()` has already walked the tree via the package manager. That walk
 * recurses into subdirectories and follows symlinks (`collectSkillEntries`
 * stats the link target and recurses when it is a directory), so the agent
 * still gets to decide how much work every later boot of the conversation does.
 * (A symlink cycle does not hang: the recursion overflows the stack and
 * `collectSkillEntries`'s own catch-all swallows it. Measured, not assumed.)
 *
 * So this implements pi's `ResourceLoader` interface with no filesystem access
 * at all. Everything Lobu wants the agent to have — skills, platform/network
 * instructions, MCP servers — arrives from the gateway as session context, so
 * there is nothing legitimate to discover here.
 *
 * The coupling to pi is the exported `ResourceLoader` interface: if a future pi
 * adds a method, this fails at compile time rather than silently reopening a
 * discovery path.
 */
import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";

export function createLobuResourceLoader(): ResourceLoader {
  // Built once, not per call: `AgentSession._buildRuntime` reads this result and
  // writes extension flag values onto `runtime`, which a fresh object per call
  // would silently discard.
  const extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {
      // pi calls this when an extension's `resources_discover` hook returns
      // paths. With no extensions loaded it never fires; ignoring the paths
      // keeps the "nothing is read from disk" property even if one is added.
    },
    reload: async () => {
      // Nothing to re-read: every getter above is a constant.
    },
  };
}

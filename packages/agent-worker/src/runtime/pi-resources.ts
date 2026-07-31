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
 *
 * Being the only thing pi loads makes this also the place Lobu's own system
 * prompt is installed — as the loader's system prompt and as a synthetic
 * `before_agent_start` extension. See `createSystemPromptExtension` for why the
 * extension, not the loader, is the seam that actually survives.
 */
import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type Extension,
  type ExtensionHandler,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { LobuSystemPromptRenderer } from "./system-prompt.js";

/** Identifies our synthetic extension in pi's diagnostics and error reports. */
const SYSTEM_PROMPT_EXTENSION_PATH = "<lobu:system-prompt>";

/**
 * The extension that installs Lobu's system prompt on every turn.
 *
 * This is not decoration over the loader's `getSystemPrompt()` — it is the only
 * seam that survives. `AgentSession.prompt()` reassigns
 * `agent.state.systemPrompt` on EVERY call: to whatever a `before_agent_start`
 * handler returns, or, when no handler returns one, back to the base prompt.
 * A system prompt assigned once after session construction is therefore
 * discarded before the first request ever reaches the model.
 *
 * Constructed by hand rather than loaded from disk: pi's loader `jiti.import`s
 * extension files, and the only directory it would read is the agent's own
 * writable workspace.
 */
function createSystemPromptExtension(
  renderSystemPrompt: LobuSystemPromptRenderer
): Extension {
  const handler: ExtensionHandler<
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult
  > = (event) => ({
    // `systemPromptOptions` carries pi's live tool snippets and per-tool
    // guidelines, so the rendered document describes the tools this agent
    // actually has without reading pi's assembled string back out.
    systemPrompt: renderSystemPrompt(event.systemPromptOptions),
  });

  return {
    path: SYSTEM_PROMPT_EXTENSION_PATH,
    resolvedPath: SYSTEM_PROMPT_EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(SYSTEM_PROMPT_EXTENSION_PATH, {
      source: "lobu",
    }),
    handlers: new Map([["before_agent_start", [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

export function createLobuResourceLoader(
  renderSystemPrompt?: LobuSystemPromptRenderer
): ResourceLoader {
  // Built once, not per call: `AgentSession._buildRuntime` reads this result and
  // writes extension flag values onto `runtime`, which a fresh object per call
  // would silently discard.
  const extensions: LoadExtensionsResult = {
    extensions: renderSystemPrompt
      ? [createSystemPromptExtension(renderSystemPrompt)]
      : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    // Pi treats this as `customPrompt`: supplying it replaces the whole default
    // prompt — harness opener, pi documentation paths and all — instead of
    // leaving Lobu text to compete with them. This is also the fallback the
    // per-turn reset lands on if the handler above ever throws, so a broken
    // extension degrades to a Lobu prompt without the tools section rather than
    // to pi's coding-harness prompt.
    getSystemPrompt: () => renderSystemPrompt?.(),
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

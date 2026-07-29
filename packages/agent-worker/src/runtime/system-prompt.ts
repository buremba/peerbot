/**
 * The Lobu agent system prompt document.
 *
 * Lobu owns the prompt's identity, instructions, and tool guidance. This is NOT
 * pi's default prompt with Lobu text patched into it — pi's default opens by
 * declaring the model an "expert coding assistant operating inside pi, a coding
 * agent harness" and closes with a block about pi's own SDK, extensions, TUI,
 * and documentation. Neither describes a Lobu agent.
 *
 * What pi still owns, and why it is read from the live build options rather
 * than copied here: the one-line tool snippets and the guideline bullets each
 * tool registers (`ToolDefinition.promptSnippet` / `.promptGuidelines`). Those
 * describe tool call semantics — that `edit` matches `oldText` exactly against
 * the original file, that disjoint edits belong in one call — and they change
 * when pi changes its tools. Re-typing them here would fork them silently.
 *
 * Document order (identity first is the point of the exercise: the model reads
 * a role declaration before anything else, and it must be the agent's):
 *   1. identity        — the agent's configured layers, or the Lobu default
 *   2. tool section    — live snippets + guidelines, from pi's build options
 *   3. gateway tail    — platform, MCP servers, network, skills, runtime shell
 *   4. date + cwd
 */
import type { BuildSystemPromptOptions } from "@mariozechner/pi-coding-agent";

/**
 * The subset of pi's system-prompt build options this module reads. Taking it
 * as a `Pick` of pi's own type (rather than a hand-rolled shape) means a field
 * pi renames stops compiling here instead of quietly rendering nothing.
 */
export type ToolPromptContext = Pick<
  BuildSystemPromptOptions,
  "selectedTools" | "toolSnippets" | "promptGuidelines"
>;

/**
 * General conduct rules. These are Lobu's, not pi's: pi adds equivalents inside
 * `buildSystemPrompt`, which the custom-prompt path never reaches, so stating
 * them here is what keeps them in the prompt at all.
 */
const LOBU_CONDUCT_GUIDELINE = "Be concise in your responses";

/** Only meaningful to an agent that was actually given file tools. */
const FILE_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash"];
const FILE_PATH_GUIDELINE = "Show file paths clearly when working with files";

/**
 * Mirrors the one conditional guideline pi derives from which tools are active
 * (`buildSystemPrompt`: bash present alongside any of grep/find/ls). It is
 * re-derived rather than copied blind so it cannot claim a tool the agent was
 * not given — a policy-restricted agent may have bash and no grep, or neither.
 */
function fileExplorationGuideline(selectedTools: string[]): string | undefined {
  if (!selectedTools.includes("bash")) return undefined;
  const hasSearchTool = ["grep", "find", "ls"].some((name) =>
    selectedTools.includes(name)
  );
  return hasSearchTool
    ? "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)"
    : "Use bash for file operations like ls, rg, find";
}

/**
 * Render the tools section. A tool appears in the list only when it carries a
 * snippet — the same rule pi applies. Tools without a registered shorthand
 * remain available through their request definitions without invented copy.
 */
function renderToolSection(context: ToolPromptContext): string {
  const selectedTools = context.selectedTools ?? [];
  const snippets = context.toolSnippets ?? {};
  const described = selectedTools.filter((name) => snippets[name]);

  const parts: string[] = [];
  if (described.length > 0) {
    parts.push(
      `Available tools:\n${described.map((name) => `- ${name}: ${snippets[name]}`).join("\n")}`,
      "You may also have other tools — memory, connectors, skills and MCP servers your organization has wired up. Their full definitions come with the request; the list above is only the shorthand."
    );
  }

  // De-duplicated, order preserved: pi's cross-tool exploration rule, its
  // tool-registered guidelines, then Lobu's conduct rules.
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string) => {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    guidelines.push(normalized);
  };
  const exploration = fileExplorationGuideline(selectedTools);
  if (exploration) addGuideline(exploration);
  for (const guideline of context.promptGuidelines ?? []) {
    addGuideline(guideline);
  }
  addGuideline(LOBU_CONDUCT_GUIDELINE);
  if (FILE_TOOLS.some((name) => selectedTools.includes(name))) {
    addGuideline(FILE_PATH_GUIDELINE);
  }

  if (guidelines.length > 0) {
    parts.push(`Guidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export interface LobuSystemPromptInput {
  /** The agent's resolved identity — configured layers, or the Lobu default. */
  identity: string;
  /**
   * Everything the gateway supplies for this run: platform instructions, MCP
   * server instructions, network access, skills, runtime shell.
   */
  gatewayInstructions: string;
  cwd: string;
  /**
   * Live tool context from pi. Omitted when the prompt is built before a turn
   * and no tool section should be rendered.
   */
  toolContext?: ToolPromptContext;
  /** Render time. Injected so the rendered document is testable. */
  now: Date;
}

function formatDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildLobuSystemPromptBody(input: LobuSystemPromptInput): string {
  const sections: string[] = [input.identity.trim()];

  if (input.toolContext) {
    const toolSection = renderToolSection(input.toolContext);
    if (toolSection) sections.push(toolSection);
  }

  const head = sections.filter(Boolean).join("\n\n");
  const tail = input.gatewayInstructions.trim();
  return tail ? `${head}\n\n---\n\n${tail}` : head;
}

export function buildLobuSystemPrompt(input: LobuSystemPromptInput): string {
  const body = buildLobuSystemPromptBody(input);
  // Trailing facts, last so they are the freshest thing the model reads. The
  // date is rendered per turn, not baked in at session construction — a session
  // that outlives midnight would otherwise keep asserting yesterday.
  return `${body}\n\nCurrent date: ${formatDate(input.now)}\nCurrent working directory: ${input.cwd.replace(/\\/g, "/")}`;
}

/**
 * A renderer bound to one run's identity and gateway instructions. Both prompt
 * delivery seams call this same function, so the base document and the per-turn
 * document cannot drift apart.
 */
export type LobuSystemPromptRenderer = (
  toolContext?: ToolPromptContext
) => string;

export function createLobuSystemPromptRenderer(base: {
  identity: string;
  gatewayInstructions: string;
  cwd: string;
}): LobuSystemPromptRenderer {
  return (toolContext) => {
    const input = { ...base, toolContext, now: new Date() };
    // The resource loader calls without tool context to obtain pi's
    // `customPrompt` input. Pi appends date and cwd while building that base
    // prompt, so return only Lobu's body there. The per-turn extension passes
    // the live context and replaces pi's assembled string, so it needs the
    // complete document including those facts.
    return toolContext
      ? buildLobuSystemPrompt(input)
      : buildLobuSystemPromptBody(input);
  };
}

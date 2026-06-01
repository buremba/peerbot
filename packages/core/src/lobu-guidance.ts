type MemoryGuidanceTools = {
  saveTool: string;
  searchTool: string;
};

const MEMORY_INTRO =
  "Your long-term memory is powered by Lobu. Do NOT use local files (memory/, MEMORY.md) for memory.";

const MEMORY_RULE_TEMPLATES = [
  "Lobu automatically recalls relevant memories when you receive a message.",
  "To save something, call {{saveTool}} with the content and an appropriate semantic_type.",
  "To search, call {{searchTool}}. Results include view_url links to the web interface.",
  "NEVER construct Lobu URLs yourself. When the user asks for a link, call {{searchTool}} to get the correct view_url.",
  'When the user says "remember this", save it to Lobu immediately.',
  "When a message changes a fact you already stored (an updated preference, status, count, location, or plan), first {{searchTool}} for the prior memory to get its id, then {{saveTool}} the new value with supersedes_event_id set to that id. This replaces the stale value so future recalls return the current one; the old value stays in history but is hidden from normal search.",
];

function renderTemplate(template: string, tools: MemoryGuidanceTools): string {
  // Use regex /g instead of String.prototype.replaceAll so this file compiles
  // against core's ES2020 lib (replaceAll lands in ES2021).
  return template
    .replace(/\{\{saveTool\}\}/g, tools.saveTool)
    .replace(/\{\{searchTool\}\}/g, tools.searchTool);
}

function renderLobuMemoryGuidance(tools: MemoryGuidanceTools): string[] {
  return MEMORY_RULE_TEMPLATES.map((template) =>
    renderTemplate(template, tools)
  );
}

export function renderFallbackSystemContext(options?: {
  gatewayMode?: boolean;
}): string {
  const isGateway = options?.gatewayMode === true;
  const tools: MemoryGuidanceTools = isGateway
    ? { saveTool: "save_memory", searchTool: "search_memory" }
    : { saveTool: "lobu_save_memory", searchTool: "lobu_search_memory" };

  const lines = renderLobuMemoryGuidance(tools);

  const authGuidance = isGateway
    ? "\n- If save_memory or search_memory returns an authentication error, call lobu_login to start authentication. After the user completes login, call lobu_login_check to finish."
    : "";

  return `<lobu-system>
## Memory

${MEMORY_INTRO}
${lines.map((line) => `- ${line}`).join("\n")}${authGuidance}
</lobu-system>`;
}

export function renderSkillMemorySection(): string {
  const lines = renderLobuMemoryGuidance({
    saveTool: "save_memory",
    searchTool: "search_memory",
  });

  return [
    "## Memory Defaults",
    "",
    MEMORY_INTRO,
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

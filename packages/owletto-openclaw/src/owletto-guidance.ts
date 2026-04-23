type MemoryGuidanceTools = {
  saveTool: string;
  searchTool: string;
};

const MEMORY_INTRO =
  'Your long-term memory is powered by Owletto. Do NOT use local files (memory/, MEMORY.md) for memory.';

const MEMORY_RULE_TEMPLATES = [
  'Owletto automatically recalls relevant memories when you receive a message.',
  'To save something, call {{saveTool}} with the content and an appropriate semantic_type.',
  'To search, call {{searchTool}}. Results include view_url links to the web interface.',
  'NEVER construct Owletto URLs yourself. When the user asks for a link, call {{searchTool}} to get the correct view_url.',
  'When the user says "remember this", save it to Owletto immediately.',
];

function renderTemplate(template: string, tools: MemoryGuidanceTools): string {
  return template
    .replaceAll('{{saveTool}}', tools.saveTool)
    .replaceAll('{{searchTool}}', tools.searchTool);
}

function renderOwlettoMemoryGuidance(tools: MemoryGuidanceTools): string[] {
  return MEMORY_RULE_TEMPLATES.map((template) => renderTemplate(template, tools));
}

export function renderFallbackSystemContext(options?: { gatewayMode?: boolean }): string {
  const isGateway = options?.gatewayMode === true;
  const tools: MemoryGuidanceTools = isGateway
    ? { saveTool: 'save_knowledge', searchTool: 'search_knowledge' }
    : { saveTool: 'owletto_save_knowledge', searchTool: 'owletto_search_knowledge' };

  const lines = renderOwlettoMemoryGuidance(tools);

  const authGuidance = isGateway
    ? '\n- If save_knowledge or search_knowledge returns an authentication error, call owletto_login to start authentication. After the user completes login, call owletto_login_check to finish.'
    : '';

  return `<owletto-system>
## Memory

${MEMORY_INTRO}
${lines.map((line) => `- ${line}`).join('\n')}${authGuidance}
</owletto-system>`;
}

export function renderSkillMemorySection(): string {
  const lines = renderOwlettoMemoryGuidance({
    saveTool: 'save_knowledge',
    searchTool: 'search_knowledge',
  });

  return ['## Memory Defaults', '', MEMORY_INTRO, ...lines.map((line) => `- ${line}`)].join('\n');
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Build markdown instructions documenting available MCP tools
 * with example curl commands for workers to call them.
 */
export function buildMcpToolInstructions(
  mcpTools: Record<string, McpToolDef[]>,
  dispatcherUrl: string
): string {
  const mcpIds = Object.keys(mcpTools);
  if (mcpIds.length === 0) return "";

  const lines: string[] = [
    "## Available MCP Tools",
    "",
    "Call tools via curl. Auth is handled automatically via the Bearer token.",
    "",
    "**Tool approval:** Some tools require user approval before use. If a tool call returns HTTP 403, the tool requires a permission grant. Use GetSettingsLink to send the user a settings link where they can approve access, then wait and retry after approval.",
    "",
  ];

  for (const mcpId of mcpIds) {
    const tools = mcpTools[mcpId];
    if (!tools || tools.length === 0) continue;

    lines.push(`### ${mcpId}`, "");

    for (const tool of tools) {
      lines.push(
        `**${tool.name}**${tool.description ? ` - ${tool.description}` : ""}`
      );

      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, any>;
        const required = (tool.inputSchema.required as string[]) || [];
        for (const [paramName, paramSchema] of Object.entries(props)) {
          const isRequired = required.includes(paramName);
          const type = paramSchema.type || "any";
          const desc = paramSchema.description || "";
          lines.push(
            `- ${paramName} (${type}${isRequired ? ", required" : ""}): ${desc}`
          );
        }
      }

      const exampleArgs: Record<string, any> = {};
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, any>;
        const required = (tool.inputSchema.required as string[]) || [];
        for (const paramName of required.slice(0, 2)) {
          const schema = props[paramName];
          if (schema?.type === "string") {
            exampleArgs[paramName] = schema.example || `<${paramName}>`;
          } else if (schema?.type === "number" || schema?.type === "integer") {
            exampleArgs[paramName] = schema.example || 0;
          } else if (schema?.type === "boolean") {
            exampleArgs[paramName] = schema.example ?? true;
          }
        }
      }

      lines.push("");
      lines.push("```bash");
      lines.push(
        `curl -s -X POST ${dispatcherUrl}/mcp/${mcpId}/tools/${tool.name} \\`,
        `  -H "Authorization: Bearer $WORKER_TOKEN" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(exampleArgs)}'`
      );
      lines.push("```", "");
    }
  }

  return lines.join("\n");
}

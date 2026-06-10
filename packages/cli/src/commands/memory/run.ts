import { ValidationError } from "./_lib/errors.js";
import { mcpRpc, resolveMcpEndpoint } from "./_lib/mcp.js";
import {
  getSessionForOrg,
  mcpUrlForOrg,
  resolveOrg,
  resolveServerUrl,
} from "./_lib/openclaw-auth.js";
import { printText } from "./_lib/output.js";

interface RunOptions {
  url?: string;
  org?: string;
  context?: string;
}

export async function memoryRunCommand(
  tool: string | undefined,
  params: string | undefined,
  options: RunOptions = {}
): Promise<void> {
  const org = await resolveOrg(options.org, undefined, options.context);
  let mcpUrl: string;

  if (org) {
    const orgSession = await getSessionForOrg(
      org,
      options.context,
      options.url
    );
    if (orgSession) {
      mcpUrl = orgSession.key;
    } else {
      const serverUrl = await resolveServerUrl(options.url, options.context);
      const base = serverUrl || (await resolveMcpEndpoint());
      if (!base)
        throw new ValidationError(
          "Server URL required. Pass --url or set LOBU_MEMORY_URL."
        );
      mcpUrl = mcpUrlForOrg(base, org);
    }
  } else {
    const serverUrl = await resolveServerUrl(options.url, options.context);
    const resolved = serverUrl || (await resolveMcpEndpoint());
    if (!resolved)
      throw new ValidationError(
        "Server URL required. Pass --url or set LOBU_MEMORY_URL."
      );
    mcpUrl = resolved;
  }

  if (!tool) {
    const result = await mcpRpc(
      mcpUrl,
      "tools/list",
      undefined,
      options.context
    );
    const resultObj = result as {
      tools?: Array<{ name: string; description?: string }>;
    };
    const toolList =
      resultObj.tools ??
      (Array.isArray(result)
        ? (result as Array<{ name: string; description?: string }>)
        : []);

    for (const t of toolList) {
      printText(`  ${t.name}${t.description ? ` — ${t.description}` : ""}`);
    }
    printText(`\n${toolList.length} tool(s)`);
    return;
  }

  const parsedParams = params ? JSON.parse(params) : {};
  const result = await mcpRpc(
    mcpUrl,
    "tools/call",
    {
      name: tool,
      arguments: parsedParams,
    },
    options.context
  );

  printText(JSON.stringify(result, null, 2));
}

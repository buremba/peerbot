import { defineCommand } from 'citty';
import { ValidationError } from '../lib/errors.ts';
import {
  getSessionForOrg,
  mcpUrlForOrg,
  resolveOrg,
  resolveServerUrl,
} from '../lib/openclaw-auth.ts';
import { isJson, printJson, printText } from '../lib/output.ts';
import { mcpRpc, resolveMcpEndpoint } from './mcp.ts';

export default defineCommand({
  meta: {
    name: 'run',
    description: 'Run an MCP tool (or list available tools when called with no arguments)',
  },
  args: {
    tool: { type: 'positional', description: 'Tool name to run', required: false },
    _params: { type: 'positional', description: 'JSON parameters', required: false },
    url: { type: 'string', description: 'Server URL (overrides OWLETTO_URL / active session)' },
    org: {
      type: 'string',
      description: 'Organization slug (overrides OWLETTO_ORG / session default)',
    },
  },
  async run({ args }) {
    const org = resolveOrg(args.org);

    // If org is specified, find the session for that org to get the right token + URL
    if (org) {
      const orgSession = getSessionForOrg(org);
      if (orgSession) {
        // Use the org session's URL directly (token is scoped to it)
        const mcpUrl = orgSession.key;
        return runMcpCommand(mcpUrl, args);
      }
      // No existing session — try building org URL from server URL
      const serverUrl = resolveServerUrl(args.url);
      const base = serverUrl || resolveMcpEndpoint();
      if (!base) throw new ValidationError('Server URL required. Run: owletto login');
      const mcpUrl = mcpUrlForOrg(base, org);
      return runMcpCommand(mcpUrl, args);
    }

    // No org override — use active session URL
    const serverUrl = resolveServerUrl(args.url);
    const mcpUrl = serverUrl || resolveMcpEndpoint();
    if (!mcpUrl) throw new ValidationError('Server URL required. Run: owletto login');
    return runMcpCommand(mcpUrl, args);
  },
});

async function runMcpCommand(mcpUrl: string, args: { tool?: string; _params?: string }) {
  if (!args.tool) {
    const result = await mcpRpc(mcpUrl, 'tools/list');

    const resultObj = result as { tools?: Array<{ name: string; description?: string }> };
    const toolList =
      resultObj.tools ??
      (Array.isArray(result) ? (result as Array<{ name: string; description?: string }>) : []);

    if (isJson()) {
      printJson({ tools: toolList });
    } else {
      for (const tool of toolList) {
        printText(`  ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`);
      }
      printText(`\n${toolList.length} tool(s)`);
    }
    return;
  }

  const params = args._params ? JSON.parse(args._params) : {};
  const result = await mcpRpc(mcpUrl, 'tools/call', {
    name: args.tool,
    arguments: params,
  });

  if (isJson()) {
    printJson({ result });
  } else {
    printText(JSON.stringify(result, null, 2));
  }
}

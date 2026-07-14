import { ValidationError } from "./errors.js";
import {
  getUsableToken,
  mcpUrlForOrg,
  resolveOrg,
  resolveServerUrl,
  type MemorySession,
} from "./memory-auth.js";
import { printText } from "../../../internal/output.js";
import { mcpRpc } from "./mcp.js";

async function resolveSessionAndUrl(
  urlFlag?: string,
  orgFlag?: string,
  context?: string
): Promise<{ token: string; session: MemorySession; mcpUrl: string }> {
  const org = await resolveOrg(orgFlag, undefined, context);
  const serverUrl = await resolveServerUrl(urlFlag, context);
  if (!serverUrl) {
    throw new ValidationError("Memory MCP URL could not be resolved.");
  }

  const mcpUrl = org ? mcpUrlForOrg(serverUrl, org) : serverUrl;
  const result = await getUsableToken(mcpUrl, context);
  if (!result) {
    throw new ValidationError("Not logged in. Run: lobu login");
  }

  return { token: result.token, session: result.session, mcpUrl };
}

export interface HealthOptions {
  url?: string;
  org?: string;
  context?: string;
}

export async function checkMemoryHealth(
  opts: HealthOptions = {}
): Promise<void> {
  // Resolve + validate auth ("Not logged in" surfaces here), then run the
  // initialize → tools/list handshake through the shared mcp.ts client, whose
  // localhost/docker-host fallback and session handling are the single impl.
  const { session, mcpUrl: targetMcpUrl } = await resolveSessionAndUrl(
    opts.url,
    opts.org,
    opts.context
  );
  const org = await resolveOrg(opts.org, session, opts.context);

  const result = (await mcpRpc(targetMcpUrl, "tools/list", {}, opts.context)) as
    | { tools?: unknown[] }
    | undefined;
  const toolsCount = Array.isArray(result?.tools) ? result.tools.length : 0;

  printText("ok: true");
  printText(`mcpUrl: ${targetMcpUrl}`);
  printText(`org: ${org || "(none)"}`);
  printText(`tools: ${toolsCount}`);
}

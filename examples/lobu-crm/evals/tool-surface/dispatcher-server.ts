/**
 * Tool-surface eval — out-of-process dispatcher server (Arm B backing).
 *
 * Why a separate process: just-bash hardens `Error.stackTraceLimit` to
 * non-writable for the full duration of a custom-command execution (sandbox
 * info-leak prevention). postgres.js stamps a cached Error on every Query
 * (`Error.stackTraceLimit = 4`), so running the real MCP handlers IN-PROCESS
 * inside a just-bash command throws "Attempted to assign to readonly property".
 *
 * Production never hits this: the just-bash MCP-CLI handler calls the gateway
 * over HTTP, and the DB work runs in the gateway PROCESS — a different `Error`
 * global. This server reproduces that boundary faithfully: it owns the Postgres
 * connection + real handlers, and Arm B's `callTool` reaches it via fetch, just
 * like `callMcpTool` reaches the real gateway.
 *
 * The org context is passed per-request (the parent created the org/types and
 * tells the child which org + user to act as).
 */

import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { dispatchTool, ensureConnected, type ScenarioOrg } from "./scenario";
import type { ToolContext } from "../../../../packages/server/src/tools/registry";

interface DispatchRequest {
  ctx: ToolContext;
  tool: string;
  args: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

// The parent already ran migrations against the shared DB; just connect.
await ensureConnected();

const server = createServer((req, res) => {
  void (async () => {
    let body: DispatchRequest;
    try {
      body = JSON.parse(await readBody(req)) as DispatchRequest;
    } catch {
      send(res, { ok: false, err: "invalid JSON request" }, 400);
      return;
    }
    const scn: ScenarioOrg = {
      org: { id: body.ctx.organizationId!, slug: "", name: "" },
      ctx: body.ctx,
    };
    try {
      const out = await dispatchTool(scn.ctx, body.tool, body.args);
      send(res, { ok: true, out });
    } catch (err) {
      // Log the detail to the dispatcher's own stderr (captured by the parent
      // harness) instead of returning it over the wire — avoids leaking
      // internal error/stack detail to the caller (CodeQL js/stack-trace-exposure).
      console.error("[dispatcher] request handler error:", err);
      send(res, { ok: false, err: "internal dispatcher error" });
    }
  })();
});

// Bind to loopback ONLY. This is an unauthenticated tool-dispatch endpoint
// reached solely by the parent harness on the same host (http://localhost:<port>);
// binding all interfaces would expose it to the local network.
server.listen(Number(process.env.DISPATCHER_PORT || 0), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // Tell the parent which port we bound.
  process.stdout.write(`DISPATCHER_READY ${port}\n`);
});

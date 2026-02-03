#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createLogger } from "@peerbot/core";
import { z } from "zod";
import type {
  ProcessInfo,
  ProcessManagerApi,
  ProcessManagerInstance,
  ResourceParams,
} from "./types";

const logger = createLogger("worker");

export function createMCPServer(manager: ProcessManagerApi): McpServer {
  const server = new McpServer({
    name: "Process Manager",
    version: "1.0.0",
  });

  // Register tools
  server.tool(
    "start_process",
    "Start a background process with monitoring and optional tunnel",
    {
      id: z.string().describe("Unique identifier for the process"),
      command: z.string().describe("Command to execute"),
      description: z.string().describe("Description of what this process does"),
      port: z
        .number()
        .optional()
        .describe("Optional port to expose via cloudflared tunnel"),
      workingDirectory: z
        .string()
        .optional()
        .describe(
          "Optional working directory for the process (defaults to workspace directory)"
        ),
    },
    async ({ id, command, description, port, workingDirectory }) => {
      try {
        const info = await manager.startProcess(
          id,
          command,
          description,
          port,
          workingDirectory
        );

        // If port is specified, wait for tunnel URL and verify service health
        if (port) {
          let tunnelUrl: string | undefined;
          let serviceHealthy = false;
          let healthCheckAttempts = 0;
          const maxHealthChecks = 60;
          const healthCheckInterval = 2000;

          logger.error(
            `[MCP Process Manager] Waiting for service on port ${port} to be ready...`
          );

          while (!serviceHealthy && healthCheckAttempts < maxHealthChecks) {
            healthCheckAttempts++;

            const currentInfo = manager.getStatus(id) as ProcessInfo | null;
            if (!currentInfo || currentInfo.status !== "running") {
              logger.error(
                `[MCP Process Manager] Process ${id} exited with code ${currentInfo?.exitCode}, stopping health checks`
              );
              break;
            }

            tunnelUrl = currentInfo.tunnelUrl;

            for (const host of ["localhost", "127.0.0.1", "0.0.0.0"]) {
              try {
                const response = await fetch(`http://${host}:${port}/`, {
                  method: "GET",
                  signal: AbortSignal.timeout(1500),
                });

                if (response.status) {
                  serviceHealthy = true;
                  logger.error(
                    `[MCP Process Manager] Service on port ${port} is healthy at ${host} (status: ${response.status})`
                  );
                  break;
                }
              } catch (error: unknown) {
                const err = error as { cause?: { code?: string } };
                if (
                  err.cause?.code === "ECONNREFUSED" &&
                  healthCheckAttempts === 1
                ) {
                  logger.error(
                    `[MCP Process Manager] Port ${port} not ready yet (connection refused)`
                  );
                }
              }
            }

            if (serviceHealthy) {
              break;
            }

            if (healthCheckAttempts % 5 === 0) {
              logger.error(
                `[MCP Process Manager] Service not ready on port ${port} (attempt ${healthCheckAttempts}/${maxHealthChecks})`
              );
            }

            await new Promise((resolve) =>
              setTimeout(resolve, healthCheckInterval)
            );
          }

          if (serviceHealthy && !tunnelUrl) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const finalInfo = manager.getStatus(id) as ProcessInfo | null;
            tunnelUrl = finalInfo?.tunnelUrl;
          }

          if (serviceHealthy && tunnelUrl) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ Started process ${id} (PID: ${info.pid})\n🌐 Tunnel URL: ${tunnelUrl}\n📡 Service verified on port ${port}`,
                },
              ],
            };
          } else if (serviceHealthy && !tunnelUrl) {
            let tunnelLogs = "";
            try {
              const tunnelLogPath = path.join(
                "/tmp/claude-logs",
                `${id}-tunnel.log`
              );
              if (existsSync(tunnelLogPath)) {
                tunnelLogs = await readFile(tunnelLogPath, "utf-8");
                const lines = tunnelLogs.split("\n");
                tunnelLogs = lines.slice(-20).join("\n");
              }
            } catch (_e) {
              // Tunnel log may not exist
            }

            return {
              content: [
                {
                  type: "text",
                  text: `⚠️ Process ${id} started (PID: ${info.pid})\n✅ Service running on port ${port}\n❌ Failed to establish tunnel\n\n**Tunnel Logs:**\n\`\`\`\n${tunnelLogs || "No tunnel logs available"}\n\`\`\``,
                },
              ],
            };
          } else {
            const processLogs = await manager.getLogs(id, 50);
            let tunnelLogs = "";
            try {
              const tunnelLogPath = path.join(
                "/tmp/claude-logs",
                `${id}-tunnel.log`
              );
              if (existsSync(tunnelLogPath)) {
                tunnelLogs = await readFile(tunnelLogPath, "utf-8");
                const lines = tunnelLogs.split("\n");
                tunnelLogs = lines.slice(-30).join("\n");
              }
            } catch (_e) {
              // Tunnel log may not exist
            }

            try {
              await manager.stopProcess(id);
            } catch (_e) {
              // Process may have already stopped
            }

            return {
              content: [
                {
                  type: "text",
                  text: `❌ Service failed to respond on port ${port} after ${(maxHealthChecks * healthCheckInterval) / 1000} seconds\n\n**Process Logs:**\n\`\`\`\n${processLogs}\n\`\`\`${tunnelLogs ? `\n\n**Tunnel Logs:**\n\`\`\`\n${tunnelLogs}\n\`\`\`` : ""}`,
                },
              ],
              isError: true,
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Started process ${id} (PID: ${info.pid})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to start process: ${error}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "stop_process",
    "Stop a running process",
    {
      id: z.string().describe("Process ID to stop"),
    },
    async ({ id }) => {
      try {
        await manager.stopProcess(id);
        return {
          content: [
            {
              type: "text",
              text: `Stopped process ${id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to stop process: ${error}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "restart_process",
    "Restart a process",
    {
      id: z.string().describe("Process ID to restart"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Optional new working directory for the process"),
    },
    async ({ id, workingDirectory }) => {
      try {
        const info = await manager.restartProcess(id, workingDirectory);
        return {
          content: [
            {
              type: "text",
              text: `Restarted process ${id} (PID: ${info.pid})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to restart process: ${error}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_process_status",
    "Get status of processes",
    {
      id: z.string().optional().describe("Process ID (omit to get all)"),
    },
    async ({ id }) => {
      const status = manager.getStatus(id);
      if (!status) {
        return {
          content: [
            {
              type: "text",
              text: `Process ${id} not found`,
            },
          ],
          isError: true,
        };
      }

      const processes = Array.isArray(status)
        ? status
        : [status as ProcessInfo];
      const statusText = processes
        .map(
          (p) =>
            `${p.id}: ${p.status}${p.pid ? ` (PID: ${p.pid})` : ""}
  Description: ${p.description}
  Started: ${p.startedAt}${p.completedAt ? `\n  Completed: ${p.completedAt}` : ""}${
    p.exitCode !== undefined ? `\n  Exit code: ${p.exitCode}` : ""
  }${p.port ? `\n  Port: ${p.port}` : ""}${p.tunnelUrl ? `\n  Tunnel URL: ${p.tunnelUrl}` : ""}
`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: statusText || "No processes found",
          },
        ],
      };
    }
  );

  server.tool(
    "get_process_logs",
    "Get logs from a process",
    {
      id: z.string().describe("Process ID"),
      lines: z
        .number()
        .optional()
        .default(50)
        .describe("Number of lines to retrieve"),
    },
    async ({ id, lines }) => {
      const logs = await manager.getLogs(id, lines);
      return {
        content: [
          {
            type: "text",
            text: logs,
          },
        ],
      };
    }
  );

  // Register resources
  server.resource(
    "processes://list",
    "List all managed processes",
    { mimeType: "application/json" },
    async () => {
      const processes = manager.getStatus() as ProcessInfo[];
      return {
        contents: [
          {
            uri: "processes://list",
            mimeType: "application/json",
            text: JSON.stringify(processes, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "processes://logs/*",
    "Get logs for a specific process",
    { mimeType: "text/plain" },
    async (params: ResourceParams) => {
      const uri = params.uri || params.url || params.toString();
      const id = uri.replace("processes://logs/", "");
      const logs = await manager.getLogs(id, 1000);
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: logs,
          },
        ],
      };
    }
  );

  server.resource(
    "processes://status/*",
    "Get status of a specific process",
    { mimeType: "application/json" },
    async (params: ResourceParams) => {
      const uri = params.uri || params.url || params.toString();
      const id = uri.replace("processes://status/", "");
      const status = manager.getStatus(id);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

/**
 * Set CORS headers for MCP SSE endpoint
 */
function setCorsHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

/**
 * Parse JSON body from request
 */
function parseJsonBody(
  req: import("node:http").IncomingMessage
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function startHTTPServer(
  server: McpServer
): Promise<ProcessManagerInstance> {
  const http = await import("node:http");
  const { URL } = await import("node:url");

  const port = parseInt(process.env.MCP_PROCESS_MANAGER_PORT || "3001", 10);
  const transports: Record<string, SSEServerTransport> = {};

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Set CORS headers for all requests
    setCorsHeaders(res);

    // Handle preflight OPTIONS requests
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /sse - SSE endpoint for MCP transport
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;

      res.on("close", () => {
        delete transports[transport.sessionId];
      });

      await server.connect(transport);
      return;
    }

    // POST /messages - Message endpoint for MCP transport
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? transports[sessionId] : undefined;

      if (transport) {
        const body = await parseJsonBody(req);
        await transport.handlePostMessage(req, res, body);
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No transport found for sessionId");
      }
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  httpServer.listen(port, () => {
    logger.info(`[Process Manager MCP] HTTP server started on port ${port}`);
  });

  const cleanup = () => {
    for (const transport of Object.values(transports)) {
      try {
        transport.close?.();
      } catch {
        // Ignore close errors
      }
    }
  };

  return {
    port,
    server,
    httpServer,
    close: async () => {
      httpServer.close();
      cleanup();
    },
    stop: async () => {
      httpServer.close();
      cleanup();
    },
  };
}

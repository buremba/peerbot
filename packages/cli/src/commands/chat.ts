import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { getToken } from "../api/credentials.js";
import { isLoadError, loadConfig } from "../config/loader.js";
import { renderMarkdown } from "../utils/markdown.js";

/**
 * `lobu chat "prompt"` — send a prompt to an agent and stream the response.
 *
 * Without --user: API mode — creates a session, sends message, streams to terminal.
 * With --user platform:id: Platform mode — sends through Telegram/Slack, response
 * appears on the platform. Terminal shows the streamed response too.
 */
export async function chatCommand(
  cwd: string,
  prompt: string,
  options: {
    agent?: string;
    gateway?: string;
    user?: string;
    thread?: string;
    dryRun?: boolean;
    new?: boolean;
  }
): Promise<void> {
  const gatewayUrl = (
    options.gateway ?? (await resolveGatewayUrl(cwd))
  ).replace(/\/$/, "");

  const authToken = (await getToken()) ?? process.env.ADMIN_PASSWORD;
  if (!authToken) {
    console.error(
      chalk.red(
        "\n  Authentication required. Run `lobu login` or set ADMIN_PASSWORD.\n"
      )
    );
    process.exit(1);
  }

  const agentId = options.agent ?? (await resolveAgentId(cwd));

  // Parse --user flag: "telegram:12345" → { platform: "telegram", userId: "12345" }
  const platformUser = options.user ? parsePlatformUser(options.user) : null;

  if (platformUser) {
    // Platform mode: route through Telegram/Slack
    await sendViaPlatform(gatewayUrl, authToken, {
      agentId,
      platform: platformUser.platform,
      userId: platformUser.userId,
      message: prompt,
      thread: options.thread,
    });
  } else {
    // API mode: create session, send message, stream response
    await sendViaApi(gatewayUrl, authToken, {
      agentId,
      message: prompt,
      thread: options.thread,
      dryRun: options.dryRun,
      forceNew: options.new,
    });
  }
}

function parsePlatformUser(
  user: string
): { platform: string; userId: string } | null {
  const colonIndex = user.indexOf(":");
  if (colonIndex === -1) {
    // No platform prefix — use as plain userId in API mode
    return null;
  }
  return {
    platform: user.slice(0, colonIndex),
    userId: user.slice(colonIndex + 1),
  };
}

/**
 * Platform mode: send message through Telegram/Slack via /api/v1/agents/{agentId}/messages.
 * The response appears on the platform AND streams to terminal via eventsUrl.
 */
async function sendViaPlatform(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    platform: string;
    userId: string;
    message: string;
    thread?: string;
  }
): Promise<void> {
  const agentId = opts.agentId || `test-${opts.platform}`;
  const body: Record<string, any> = {
    platform: opts.platform,
    content: opts.message,
  };

  // Platform-specific routing
  if (opts.platform === "telegram") {
    body.telegram = { chatId: opts.userId };
  } else if (opts.platform === "slack") {
    body.slack = {
      channel: opts.userId,
      thread: opts.thread,
    };
  } else if (opts.platform === "discord") {
    body.discord = { channelId: opts.userId };
  }

  const res = await fetch(
    `${gatewayUrl}/api/v1/agents/${encodeURIComponent(agentId)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const resBody = await res.text().catch(() => "");
    console.error(
      chalk.red(`\n  Failed to send message (${res.status}): ${resBody}\n`)
    );
    process.exit(1);
  }

  const result = (await res.json()) as {
    success: boolean;
    agentId?: string;
    eventsUrl?: string;
    queued?: boolean;
  };

  if (result.eventsUrl) {
    // Stream the response from the agent
    const sseUrl = result.eventsUrl.startsWith("http")
      ? result.eventsUrl
      : `${gatewayUrl}${result.eventsUrl}`;

    const sseController = new AbortController();
    await streamResponse(sseUrl, authToken, sseController);
  } else {
    console.log(
      chalk.dim(
        `  Message sent via ${opts.platform}. Response will appear on the platform.\n`
      )
    );
  }
}

/**
 * API mode: create session, send message, stream response to terminal.
 */
async function sendViaApi(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    message: string;
    thread?: string;
    dryRun?: boolean;
    forceNew?: boolean;
  }
): Promise<void> {
  const createBody: Record<string, any> = {};
  if (opts.agentId) createBody.agentId = opts.agentId;
  if (opts.thread) createBody.thread = opts.thread;
  if (opts.dryRun) createBody.dryRun = true;
  if (opts.forceNew) createBody.forceNew = true;

  const createRes = await fetch(`${gatewayUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(createBody),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    if (createRes.status === 401) {
      console.error(
        chalk.red(
          "\n  Authentication required. Run `lobu login` or set ADMIN_PASSWORD.\n"
        )
      );
      process.exit(1);
    }
    console.error(
      chalk.red(`\n  Failed to create session (${createRes.status}): ${body}\n`)
    );
    process.exit(1);
  }

  const session = (await createRes.json()) as {
    agentId: string;
    token: string;
  };

  const base = `${gatewayUrl}/api/v1/agents/${session.agentId}`;
  const sseUrl = `${base}/events`;
  const messagesUrl = `${base}/messages`;

  const sseController = new AbortController();
  const streaming = streamResponse(sseUrl, session.token, sseController);

  const msgRes = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ content: opts.message }),
  });

  if (!msgRes.ok) {
    sseController.abort();
    const body = await msgRes.text().catch(() => "");
    console.error(
      chalk.red(`\n  Failed to send message (${msgRes.status}): ${body}\n`)
    );
    process.exit(1);
  }

  await streaming;
}

async function resolveAgentId(cwd: string): Promise<string | undefined> {
  const result = await loadConfig(cwd);
  if (isLoadError(result)) return undefined;
  const ids = Object.keys(result.config.agents);
  return ids[0];
}

async function streamResponse(
  sseUrl: string,
  token: string,
  controller: AbortController
): Promise<void> {
  const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;
  const IDLE_TIMEOUT_MS = 60 * 1000;

  const overallTimer = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);
  let idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(sseUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      console.error(chalk.red(`\n  SSE connection failed (${res.status})\n`));
      process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ") && currentEvent) {
          const data = parseJSON(line.slice(6));
          if (!data) continue;

          switch (currentEvent) {
            case "output":
              if (typeof data.content === "string")
                process.stdout.write(renderMarkdown(data.content));
              break;
            case "ephemeral":
              if (typeof data.content === "string") {
                console.error(`\n${renderMarkdown(data.content)}\n`);
              }
              controller.abort();
              return;
            case "link-button":
            case "question":
            case "grant-request":
            case "package-request":
            case "suggestion":
              console.error(JSON.stringify({ event: currentEvent, ...data }));
              break;
            case "complete":
              process.stdout.write("\n");
              controller.abort();
              return;
            case "error":
              process.stdout.write("\n");
              console.error(
                chalk.red(`\n  Agent error: ${String(data.error)}\n`)
              );
              controller.abort();
              return;
          }

          currentEvent = "";
        } else if (line === "") {
          currentEvent = "";
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
  }
}

function parseJSON(str: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(str);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveGatewayUrl(cwd: string): Promise<string> {
  try {
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("GATEWAY_PORT=")) {
        let port = trimmed.slice("GATEWAY_PORT=".length);
        if (
          (port.startsWith('"') && port.endsWith('"')) ||
          (port.startsWith("'") && port.endsWith("'"))
        ) {
          port = port.slice(1, -1);
        }
        if (port) return `http://localhost:${port}`;
      }
    }
  } catch {
    // No .env file
  }
  return "http://localhost:8080";
}

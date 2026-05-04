import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import {
  apiBaseFromContextUrl,
  getCurrentContextName,
  getToken,
  resolveContext,
  resolveGatewayUrl,
} from "../internal/index.js";
import { LOBU_CONFIG_DIR } from "../internal/context.js";
import { isLoadError, loadConfig } from "../config/loader.js";
import { renderMarkdown } from "../utils/markdown.js";

const THREADS_FILE = join(LOBU_CONFIG_DIR, "threads.json");

async function getLastThread(
  context: string,
  agent: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(THREADS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed[`${context}|${agent}`];
  } catch {
    return undefined;
  }
}

async function setLastThread(
  context: string,
  agent: string,
  threadId: string
): Promise<void> {
  let store: Record<string, string> = {};
  try {
    const raw = await readFile(THREADS_FILE, "utf-8");
    store = JSON.parse(raw) as Record<string, string>;
  } catch {
    // first-write or corrupt; reset
  }
  store[`${context}|${agent}`] = threadId;
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(THREADS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

export interface ChatOptions {
  agent?: string;
  gateway?: string;
  user?: string;
  thread?: string;
  dryRun?: boolean;
  new?: boolean;
  continue?: boolean;
  context?: string;
  autoApprove?: boolean;
  json?: boolean;
}

/**
 * `lobu chat <prompt>` — send a prompt to an agent and stream the response.
 *
 * With --user platform:id, routes through Telegram/Slack.
 * With --continue, resumes the last thread for (context, agent).
 */
export async function chatCommand(
  cwd: string,
  prompt: string,
  options: ChatOptions
): Promise<void> {
  let gatewayUrl: string;
  if (options.gateway) {
    gatewayUrl = options.gateway;
  } else if (options.context) {
    const ctx = await resolveContext(options.context);
    gatewayUrl = apiBaseFromContextUrl(ctx.apiUrl);
  } else {
    gatewayUrl = await resolveGatewayUrl({ cwd });
  }
  gatewayUrl = gatewayUrl.replace(/\/$/, "");

  const authToken = await getToken(options.context);
  if (!authToken) {
    console.error(
      chalk.red("\n  Session expired or not logged in. Run `lobu login`.\n")
    );
    process.exit(1);
  }

  const agentId = options.agent ?? (await resolveAgentId(cwd));
  const platformUser = options.user ? parsePlatformUser(options.user) : null;
  const contextName = options.context ?? (await getCurrentContextName());

  // Resolve thread: explicit --thread > --continue (last for this agent)
  let threadId = options.thread;
  if (!threadId && options.continue && agentId) {
    threadId = await getLastThread(contextName, agentId);
    if (!threadId) {
      console.error(
        chalk.dim(
          `\n  No prior thread for ${agentId} in context ${contextName}; starting fresh.\n`
        )
      );
    }
  }

  if (platformUser) {
    await sendViaPlatform(gatewayUrl, authToken, {
      agentId,
      platform: platformUser.platform,
      userId: platformUser.userId,
      message: prompt,
      thread: threadId,
      json: options.json,
    });
  } else {
    await sendViaApi(gatewayUrl, authToken, {
      agentId,
      message: prompt,
      thread: threadId,
      dryRun: options.dryRun,
      forceNew: options.new && !threadId,
      autoApprove: options.autoApprove,
      json: options.json,
      contextName,
    });
  }
}

function parsePlatformUser(
  user: string
): { platform: string; userId: string } | null {
  const colonIndex = user.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    platform: user.slice(0, colonIndex),
    userId: user.slice(colonIndex + 1),
  };
}

async function sendViaPlatform(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    platform: string;
    userId: string;
    message: string;
    thread?: string;
    json?: boolean;
  }
): Promise<void> {
  const agentId = opts.agentId || `test-${opts.platform}`;
  const body: Record<string, any> = {
    platform: opts.platform,
    content: opts.message,
  };

  if (opts.platform === "telegram") {
    body.telegram = { chatId: opts.userId };
  } else if (opts.platform === "slack") {
    body.slack = { channel: opts.userId, thread: opts.thread };
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
    messageId?: string;
    eventsUrl?: string;
    queued?: boolean;
  };

  if (result.eventsUrl) {
    const sseUrl = result.eventsUrl.startsWith("http")
      ? result.eventsUrl
      : `${gatewayUrl}${result.eventsUrl}`;

    const sseController = new AbortController();
    await streamResponse(sseUrl, authToken, sseController, {
      expectedMessageId: result.messageId,
      json: opts.json,
    });
  } else {
    console.log(
      chalk.dim(
        `  Message sent via ${opts.platform}. Response will appear on the platform.\n`
      )
    );
  }
}

interface ApiSendOptions {
  agentId?: string;
  message: string;
  thread?: string;
  dryRun?: boolean;
  forceNew?: boolean;
  autoApprove?: boolean;
  json?: boolean;
  contextName?: string;
}

interface ApiSession {
  agentId: string;
  token: string;
  threadId?: string;
}

async function createSession(
  gatewayUrl: string,
  authToken: string,
  opts: {
    agentId?: string;
    thread?: string;
    dryRun?: boolean;
    forceNew?: boolean;
  }
): Promise<ApiSession> {
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
        chalk.red("\n  Authentication required. Run `lobu login`.\n")
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
    threadId?: string;
    thread?: string;
  };
  return {
    agentId: session.agentId,
    token: session.token,
    threadId: session.threadId ?? session.thread,
  };
}

async function sendViaApi(
  gatewayUrl: string,
  authToken: string,
  opts: ApiSendOptions
): Promise<void> {
  const session = await createSession(gatewayUrl, authToken, {
    agentId: opts.agentId,
    thread: opts.thread,
    dryRun: opts.dryRun,
    forceNew: opts.forceNew,
  });

  const base = `${gatewayUrl}/api/v1/agents/${session.agentId}`;
  const sseUrl = `${base}/events`;
  const messagesUrl = `${base}/messages`;

  const sseController = new AbortController();
  const streaming = streamResponse(sseUrl, session.token, sseController, {
    autoApprove: opts.autoApprove,
    json: opts.json,
  });

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

  if (opts.contextName && session.threadId) {
    await setLastThread(opts.contextName, session.agentId, session.threadId);
  }
}

async function resolveAgentId(cwd: string): Promise<string | undefined> {
  const result = await loadConfig(cwd);
  if (isLoadError(result)) return undefined;
  const ids = Object.keys(result.config.agents);
  return ids[0];
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function writeStderr(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

interface StreamOptions {
  expectedMessageId?: string;
  autoApprove?: boolean;
  json?: boolean;
}

async function streamResponse(
  sseUrl: string,
  token: string,
  controller: AbortController,
  options: StreamOptions = {}
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
    let sawFileUploadedEvent = false;
    let sawSandboxLink = false;

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
          if (
            options.expectedMessageId &&
            currentEvent !== "connected" &&
            currentEvent !== "ping" &&
            typeof data.messageId === "string" &&
            data.messageId !== options.expectedMessageId
          ) {
            currentEvent = "";
            continue;
          }

          if (options.json) {
            await writeStdout(
              `${JSON.stringify({ event: currentEvent, ...data })}\n`
            );
            if (currentEvent === "complete" || currentEvent === "error") {
              controller.abort();
              return;
            }
            currentEvent = "";
            continue;
          }

          switch (currentEvent) {
            case "output":
              if (typeof data.content === "string") {
                if (data.content.includes("sandbox:/")) {
                  sawSandboxLink = true;
                }
                await writeStdout(data.content);
              }
              break;
            case "ephemeral":
              if (typeof data.content === "string") {
                await writeStderr(`\n${renderMarkdown(data.content)}\n`);
              }
              controller.abort();
              return;
            case "tool-approval": {
              const args = data.args as Record<string, unknown> | undefined;
              const argsText = args
                ? Object.entries(args)
                    .map(
                      ([k, v]) =>
                        `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
                    )
                    .join("\n")
                : "";
              await writeStderr(
                chalk.yellow(
                  `\n  Tool Approval Required\n  ${data.mcpId} → ${data.toolName}\n${argsText}\n`
                )
              );

              let decision: string;
              if (options.autoApprove) {
                decision = "always";
                await writeStderr(
                  chalk.dim("\n  --auto-approve: approving (always).\n")
                );
              } else {
                const choices = ["1h", "24h", "always", "deny"];
                const labels: Record<string, string> = {
                  "1h": "1h",
                  "24h": "24h",
                  always: "always",
                  deny: "deny always",
                };
                await writeStderr(
                  `${choices
                    .map(
                      (o, i) =>
                        `  ${chalk.bold(`${i + 1}`)}. ${o === "deny" ? chalk.red(labels[o]) : chalk.green(labels[o])}`
                    )
                    .join("\n")}\n`
                );

                const rl = createInterface({
                  input: process.stdin,
                  output: process.stderr,
                });
                const answer = await new Promise<string>((resolve) =>
                  rl.question(chalk.dim("\n  Choice (1-4): "), (a) => {
                    rl.close();
                    resolve(a.trim());
                  })
                );
                const idx = Number.parseInt(answer, 10) - 1;
                decision = choices[idx] || "deny";
              }

              const approveUrl = sseUrl
                .replace(/\/events$/, "")
                .replace(/\/api\/v1\/agents\/[^/]+/, "/api/v1/agents/approve");
              const approveRes = await fetch(approveUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ requestId: data.requestId, decision }),
              });
              if (approveRes.ok) {
                const result = (await approveRes.json()) as any;
                if (result.result?.content) {
                  const text = result.result.content
                    .map((c: any) => c.text)
                    .join("\n");
                  await writeStdout(renderMarkdown(text));
                }
                await writeStderr(
                  chalk.green(
                    `\n  Tool ${decision === "deny" ? "denied" : "approved"} (${decision})\n`
                  )
                );
              } else {
                await writeStderr(
                  chalk.red(`\n  Approval failed: ${await approveRes.text()}\n`)
                );
              }
              break;
            }
            case "link-button":
            case "question":
            case "suggestion":
            case "file-uploaded":
              if (currentEvent === "file-uploaded") {
                sawFileUploadedEvent = true;
              }
              await writeStderr(
                `${JSON.stringify({ event: currentEvent, ...data })}\n`
              );
              break;
            case "complete":
              await writeStdout("\n");
              if (sawSandboxLink && !sawFileUploadedEvent) {
                await writeStderr(
                  chalk.red(
                    "\n  Warning: assistant output contained a sandbox/local file link, but no file-uploaded event was emitted. Treat this as a failed file-delivery attempt.\n"
                  )
                );
              }
              controller.abort();
              return;
            case "error":
              await writeStdout("\n");
              await writeStderr(
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

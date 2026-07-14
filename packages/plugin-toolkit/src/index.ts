import { createLogger, getCustomToolDescription } from "@lobu/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";

const logger = createLogger("plugin-toolkit");

export interface TextResult {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: "text"; text: string }>;
}

export interface GatewayParams {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  platform?: string;
  workspaceDir?: string;
}

export interface GatewayRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createGatewayClient(config: {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
}): { request(path: string, init?: GatewayRequestInit): Promise<Response> } {
  const fetchFn = config.fetchFn ?? fetch;
  return {
    request(path, init = {}) {
      return fetchFn(`${config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...init.headers,
        },
        body: init.body,
        signal:
          init.signal ??
          (init.timeoutMs !== undefined
            ? AbortSignal.timeout(init.timeoutMs)
            : undefined),
      });
    },
  };
}

export function textResult(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(payload: Record<string, unknown>): TextResult {
  return textResult(JSON.stringify(payload));
}

export function joinTextContent(
  content: Array<{ type: string; text?: string }> | undefined
): string {
  return (content ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

export function withErrorHandling(
  label: string,
  fn: () => Promise<TextResult>
): Promise<TextResult> {
  return fn().catch((error) => {
    logger.error(`${label} error:`, error);
    return textResult(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

export async function parseErrorBody(
  response: Response
): Promise<{ error?: string }> {
  return response
    .json()
    .catch(() => ({ error: response.statusText })) as Promise<{
    error?: string;
  }>;
}

export async function gatewayFetch<T>(
  gateway: GatewayParams,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
  errorPrefix: string
): Promise<{ data?: T; error?: TextResult }> {
  let response: Response;
  try {
    response = await createGatewayClient({
      baseUrl: gateway.gatewayUrl,
      token: gateway.workerToken,
    }).request(path, {
      ...options,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      logger.error(`${errorPrefix}: request timed out`);
      return { error: textResult(`Error: ${errorPrefix} (timed out)`) };
    }
    throw error;
  }

  if (!response.ok) {
    const body = await parseErrorBody(response);
    logger.error(`${errorPrefix}: ${response.status}`, body);
    return { error: textResult(`Error: ${body.error || errorPrefix}`) };
  }
  return { data: (await response.json()) as T };
}

export async function postLinkButton(
  gateway: GatewayParams,
  args: {
    url: string;
    label: string;
    linkType?: "settings" | "install" | "oauth";
    body?: string;
  }
): Promise<void> {
  const { error } = await gatewayFetch<{ id: string }>(
    gateway,
    "/internal/interactions/create",
    {
      method: "POST",
      body: JSON.stringify({
        interactionType: "link_button",
        url: args.url,
        label: args.label,
        linkType: args.linkType ?? "oauth",
        body: args.body,
      }),
    },
    "Failed to post link button"
  );
  if (error) {
    throw new Error(
      joinTextContent(error.content) || "Failed to post link button"
    );
  }
}

export function toToolResult(
  result: TextResult
): AgentToolResult<Record<string, unknown>> {
  return { content: result.content, details: {} };
}

export function defineTool<T extends TSchema>(config: {
  name: string;
  description: string;
  parameters: T;
  run: (args: Static<T>) => Promise<TextResult>;
}): ToolDefinition {
  return {
    name: config.name,
    label: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: async (_toolCallId, args) =>
      toToolResult(await config.run(args as Static<T>)),
  };
}

export function defineGatewayTool<T extends TSchema>(config: {
  name: string;
  parameters: T;
  run: (args: Static<T>) => Promise<TextResult>;
}): ToolDefinition {
  return defineTool({
    ...config,
    description: getCustomToolDescription(config.name),
  });
}

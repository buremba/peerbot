/**
 * Minimal client for the LOCAL Lobu gateway started by `lobu run`.
 *
 * Auth: `POST /api/local-init` mints a session for the single-operator local
 * install (loopback-only endpoint; `X-Lobu-Client` is its CSRF gate). Tools
 * are then plain REST: `POST /api/:orgSlug/:toolName` with a bearer token —
 * the same admin surface `lobu call` uses.
 */

import { GATEWAY_URL } from "./env.ts";

export interface Gateway {
  base: string;
  org: string;
  token: string;
}

export async function connectLocalGateway(): Promise<Gateway> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/api/local-init`, {
      method: "POST",
      headers: { "X-Lobu-Client": "context-layer-example" },
    });
  } catch (err) {
    throw new Error(
      `Cannot reach the local gateway at ${GATEWAY_URL} — is \`lobu run\` running in this directory? (${err})`
    );
  }
  if (!res.ok) {
    throw new Error(
      `local-init failed (${res.status}): ${await res.text()} — this example needs the embedded local server started by \`lobu run\`.`
    );
  }
  const body = (await res.json()) as {
    session_token?: string;
    device_token?: string;
    organization?: { slug?: string };
  };
  const token = body.session_token ?? body.device_token;
  const org = body.organization?.slug;
  if (!token || !org) {
    throw new Error(
      `local-init returned no session/org: ${JSON.stringify(body)}`
    );
  }
  return { base: GATEWAY_URL, org, token };
}

export async function callTool<T = Record<string, unknown>>(
  gw: Gateway,
  tool: string,
  args: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${gw.base}/api/${gw.org}/${tool}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gw.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${tool} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

interface SdkScriptResult {
  success: boolean;
  return_value?: unknown;
  logs: Array<{ level: string; message: string }>;
  error?: { name: string; message: string; line?: number };
  duration_ms: number;
  sdk_calls: number;
}

/**
 * Submit a sandboxed SDK script SOURCE (a string exporting
 * `default async (ctx, client) => ...`) to the gateway's `run_sdk` tool and
 * return its return_value. The example keeps its sandbox body inline in the
 * calling script for readability, so the source is passed directly. Script logs
 * are forwarded to the terminal.
 */
export async function runSdkSource<T>(gw: Gateway, script: string): Promise<T> {
  const result = await callTool<SdkScriptResult>(gw, "run_sdk", {
    script,
    timeout_ms: 60_000,
  });
  for (const log of result.logs ?? []) {
    console.error(`  [sandbox:${log.level}] ${log.message}`);
  }
  if (!result.success) {
    throw new Error(
      `run_sdk script failed: ${result.error?.name}: ${result.error?.message}` +
        (result.error?.line ? ` (line ${result.error.line})` : "")
    );
  }
  console.error(
    `  (run_sdk: ${result.sdk_calls} SDK calls in ${result.duration_ms}ms, sandboxed)`
  );
  return result.return_value as T;
}

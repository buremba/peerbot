/**
 * Tests for the `agentApiBase` helper and `resolveGatewayUrl`.
 *
 * These functions determine the `/lobu` API prefix that `lobu chat` and
 * `lobu eval` use to construct their endpoint URLs — a regression here
 * silently breaks all chat/eval connections.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentApiBase,
  GATEWAY_AGENT_API_PREFIX,
  GATEWAY_DEFAULT_URL,
  resolveGatewayUrl,
} from "../gateway-url.js";

describe("agentApiBase — /lobu prefix construction", () => {
  test("appends /lobu to a plain origin URL", () => {
    expect(agentApiBase("http://localhost:8787")).toBe(
      "http://localhost:8787/lobu"
    );
  });

  test("appends /lobu to a cloud origin URL", () => {
    expect(agentApiBase("https://app.lobu.ai")).toBe(
      "https://app.lobu.ai/lobu"
    );
  });

  test("is idempotent: URL that already ends with /lobu is unchanged", () => {
    expect(agentApiBase("http://localhost:8787/lobu")).toBe(
      "http://localhost:8787/lobu"
    );
  });

  test("strips trailing slash before appending /lobu", () => {
    expect(agentApiBase("http://localhost:8787/")).toBe(
      "http://localhost:8787/lobu"
    );
  });

  test("multiple trailing slashes are stripped", () => {
    expect(agentApiBase("http://localhost:8787///")).toBe(
      "http://localhost:8787/lobu"
    );
  });

  test("URL with a path that does NOT end in /lobu gets /lobu appended", () => {
    // e.g. if someone passes https://app.lobu.ai/api/v1 by mistake
    expect(agentApiBase("https://app.lobu.ai/api/v1")).toBe(
      "https://app.lobu.ai/api/v1/lobu"
    );
  });

  test("GATEWAY_AGENT_API_PREFIX constant equals '/lobu'", () => {
    expect(GATEWAY_AGENT_API_PREFIX).toBe("/lobu");
  });

  test("GATEWAY_DEFAULT_URL constant is localhost:8787", () => {
    expect(GATEWAY_DEFAULT_URL).toBe("http://localhost:8787");
  });
});

// ── resolveGatewayUrl ────────────────────────────────────────────────────────

describe("resolveGatewayUrl", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function mkDir(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "lobu-gw-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  test("returns default URL when no .env file exists", async () => {
    const dir = mkDir();
    const url = await resolveGatewayUrl({ cwd: dir });
    expect(url).toBe(GATEWAY_DEFAULT_URL);
  });

  test("returns default URL when .env exists but has no PORT/GATEWAY_PORT", async () => {
    const dir = mkDir({ ".env": "SOME_OTHER_VAR=foo\n" });
    const url = await resolveGatewayUrl({ cwd: dir });
    expect(url).toBe(GATEWAY_DEFAULT_URL);
  });

  test("uses PORT from .env to construct the gateway URL", async () => {
    const dir = mkDir({ ".env": "PORT=9000\n" });
    const url = await resolveGatewayUrl({ cwd: dir });
    expect(url).toBe("http://localhost:9000");
  });

  test("uses GATEWAY_PORT from .env (takes precedence over PORT)", async () => {
    const dir = mkDir({ ".env": "GATEWAY_PORT=8788\nPORT=9000\n" });
    const url = await resolveGatewayUrl({ cwd: dir });
    expect(url).toBe("http://localhost:8788");
  });

  test("uses process.cwd() when no cwd is supplied", async () => {
    // Can't guarantee .env in the actual cwd, just verify it doesn't throw.
    const url = await resolveGatewayUrl();
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

// ── Eval client uses /api/v1/agents (NOT /lobu/api/v1/agents) ─────────────────

describe("eval client createSession URL contract", () => {
  /**
   * The eval client sends requests to `${gatewayUrl}/api/v1/agents` — it
   * expects `gatewayUrl` to already include the `/lobu` prefix (supplied by
   * `agentApiBase()`). This test documents the expected shape without hitting
   * the network.
   */
  test("agentApiBase + /api/v1/agents produces the correct eval endpoint", () => {
    const gatewayUrl = agentApiBase("http://localhost:8787");
    // The eval `createSession` function calls `${gatewayUrl}/api/v1/agents`
    expect(`${gatewayUrl}/api/v1/agents`).toBe(
      "http://localhost:8787/lobu/api/v1/agents"
    );
  });

  test("works with the cloud URL", () => {
    const gatewayUrl = agentApiBase("https://app.lobu.ai");
    expect(`${gatewayUrl}/api/v1/agents`).toBe(
      "https://app.lobu.ai/lobu/api/v1/agents"
    );
  });
});

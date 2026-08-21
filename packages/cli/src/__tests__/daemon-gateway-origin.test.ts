import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { hostname } from "node:os";
import * as daemonModule from "@lobu/connector-worker/daemon";
import { daemonCommand } from "../commands/daemon";
import { apiUrlToGatewayOrigin } from "../internal/context";
import * as context from "../internal/context";
import * as deviceState from "../internal/device-state";
import * as deviceWizardModule from "../commands/_lib/device-wizard";

/**
 * Context URLs carry the SDK path (`https://app.lobu.ai/api/v1`) but the worker
 * API is mounted at the app root, so handing the context URL straight to a
 * device worker builds `/api/v1/api/workers/poll` and every call 404s. Only
 * production contexts carry that path — a local context is a bare
 * `http://localhost:<port>` — so the mismatch is invisible in dev and shows up
 * only against prod.
 */

describe("apiUrlToGatewayOrigin", () => {
  test("strips the /api/v1 SDK path from a production context URL", () => {
    expect(apiUrlToGatewayOrigin("https://app.lobu.ai/api/v1")).toBe(
      "https://app.lobu.ai"
    );
  });

  test("leaves a bare local context origin alone, port included", () => {
    expect(apiUrlToGatewayOrigin("http://localhost:8795")).toBe(
      "http://localhost:8795"
    );
  });

  test("hands back an unparseable value trimmed rather than throwing", () => {
    // The user's first request then fails against the address they configured,
    // which is a better error than a stack trace from URL parsing.
    expect(apiUrlToGatewayOrigin("not a url/")).toBe("not a url");
  });
});

/**
 * Every env key `detectInteractiveSession` triggers on. The suite itself often
 * runs inside one of these agents, so leaving any of them set would silently
 * route `daemonCommand` down the per-session lane and make the host-device
 * assertions below pass or fail depending on where the tests are run.
 */
const SESSION_ENV_KEYS = [
  "WORKER_API_TOKEN",
  "CI",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "OPENCODE_PID",
  "OPENCODE_SESSION_ID",
] as const;

describe("lobu daemon", () => {
  const originalEnv = new Map<string, string | undefined>();
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    for (const key of SESSION_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    process.env.WORKER_API_TOKEN = "owl_pat_durable-device-token";
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) restoreEnv(key, value);
    originalEnv.clear();
    (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = originalStdoutIsTTY;
    mock.restore();
  });

  test("auto-discovers the gateway ORIGIN, not the context's SDK path", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.apiUrl).toBe("https://app.lobu.ai");
  });

  test("an explicit --api-url is passed through untouched", async () => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(start.mock.calls[0]?.[0]?.apiUrl).toBe("http://127.0.0.1:9564");
  });

  test("--inside-claude bypasses cache and wizard so the daemon derives a per-session id", async () => {
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-host",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-host",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      insideClaude: true,
    });

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      apiUrl: "http://127.0.0.1:9564",
      platform: "headless",
      defaultPlatform: process.platform === "darwin" ? "macos" : "headless",
      workerId: undefined,
      insideClaude: true,
    });
    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });

  test("an explicit --worker-id wins while --inside-claude still forces its lane", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      workerId: "headless:attached-explicit",
      insideClaude: true,
    });

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      workerId: "headless:attached-explicit",
      insideClaude: true,
    });
  });

  test("auto-detected Codex bypasses the host cache and remains in the centralized session lane", async () => {
    process.env.CODEX_THREAD_ID = "thread-exact";
    process.env.CODEX_SESSION_ID = "thread-exact";
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-host",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-host",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(start.mock.calls[0]?.[0]?.workerId).toBeUndefined();
    expect(start.mock.calls[0]?.[0]?.platform).toBe("headless");
    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });

  test("non-interactive first run falls back to the computed default id", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8795",
      source: "config",
    });
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.workerId).toBe(
      `${process.platform === "darwin" ? "macos" : "headless"}:${hostname().split(".")[0]}`
    );
  });

  test("non-interactive boot reuses a cached device id when present", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8795",
      source: "config",
    });
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:confirmed-box",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.workerId).toBe("macos:confirmed-box");
  });

  test("interactive boot with a cached device id does not re-prompt via the wizard", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8795",
      source: "config",
    });
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:confirmed-box",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:should-not-run",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    await daemonCommand({});

    // The cached id wins and the wizard never runs once a device is configured.
    expect(wizard).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerId).toBe("macos:confirmed-box");
  });

  test("a stored OAuth login never substitutes for a durable worker PAT", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );
    await expect(daemonCommand({})).rejects.toThrow(
      /durable.*WORKER_API_TOKEN.*device_worker:run/s
    );
    expect(start).not.toHaveBeenCalled();
  });

  test("a fresh TTY runs the wizard once and forwards its chosen identity", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:chosen-by-wizard",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(wizard).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]?.workerId).toBe("macos:chosen-by-wizard");
  });

  test("CI never prompts even when attached to a pseudo-TTY", async () => {
    process.env.CI = "true";
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:should-not-run",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(wizard).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerId).toContain(":");
  });

  test("--no-interactive-session is forwarded as an explicit opt-out", async () => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      interactiveSession: false,
    });

    expect(start.mock.calls[0]?.[0]?.interactiveSession).toBe(false);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

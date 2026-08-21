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
import * as credentials from "../internal/credentials";
import * as deviceState from "../internal/device-state";

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

describe("lobu daemon", () => {
  beforeEach(() => {
    // Deterministic auth precondition so the setup guard never fires and each
    // test drives `startDaemonCommand` regardless of the host's real config.
    spyOn(credentials, "getToken").mockResolvedValue("session-token");
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(() => {
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

  test("--inside-claude is forwarded for centralized interactive detection", async () => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      insideClaude: true,
    });

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      apiUrl: "http://127.0.0.1:9564",
      platform: undefined,
      defaultPlatform: process.platform === "darwin" ? "macos" : "headless",
      insideClaude: true,
    });
  });

  test("an explicit --worker-id is passed through and never overridden", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ workerId: "macos:mybox" });

    expect(start.mock.calls[0]?.[0]?.workerId).toBe("macos:mybox");
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
      workerTokenPrefix: "owl_pat_x",
      registeredAt: new Date().toISOString(),
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.workerId).toBe("macos:confirmed-box");
  });

  test("fresh install with no session and no durable token gets setup guidance", async () => {
    // No stored credential and a placeholder default context → the daemon has
    // nothing to authorize against and should say so up front, not hit the
    // fail-closed PAT guard with no context.
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    credentials.getToken.mockResolvedValueOnce(null as never);
    delete process.env.WORKER_API_TOKEN;

    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );
    await expect(daemonCommand({})).rejects.toThrow(
      "Could not determine a gateway to poll"
    );
    expect(start).not.toHaveBeenCalled();
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

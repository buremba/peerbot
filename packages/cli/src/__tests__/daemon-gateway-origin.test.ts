import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as daemonModule from "@lobu/connector-worker/daemon";
import { daemonCommand } from "../commands/daemon";
import { apiUrlToGatewayOrigin } from "../internal/context";
import * as context from "../internal/context";

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

  test("--inside-claude is explicit and uses an isolated headless device", async () => {
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
      insideClaude: true,
    });
  });

  test("the default daemon does not enable parent delivery", async () => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(start.mock.calls[0]?.[0]?.insideClaude).toBeUndefined();
  });
});

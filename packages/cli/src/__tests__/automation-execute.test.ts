import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as daemon from "@lobu/connector-worker/daemon";
import { automationExecuteCommand } from "../commands/automation";
import * as context from "../internal/context";

/**
 * `lobu automation execute` is a HANDOFF: a native bridge has already claimed
 * the run, so exit status decides which side reports the outcome. Anything that
 * inverts it leaves the run double-reported or silently unreported, so these
 * pin the contract rather than the plumbing.
 *
 *   throws (non-zero exit) → nothing reported, caller still owns the run
 *   returns (exit 0)       → this process owns the outcome, caller must not report
 */

const tmp = mkdtempSync(path.join(tmpdir(), "lobu-automation-cli-"));
let seq = 0;

function envelopeFile(
  body: string = JSON.stringify({ run_id: 7, run_type: "automation" })
): string {
  const file = path.join(tmp, `envelope-${seq++}.json`);
  writeFileSync(file, body);
  return file;
}

function withEnv(token: string | undefined, fn: () => Promise<void>) {
  const prior = process.env.WORKER_API_TOKEN;
  if (token === undefined) delete process.env.WORKER_API_TOKEN;
  else process.env.WORKER_API_TOKEN = token;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.WORKER_API_TOKEN;
    else process.env.WORKER_API_TOKEN = prior;
  });
}

describe("lobu automation execute", () => {
  afterEach(() => {
    mock.restore();
  });

  test("reduces the context URL to the gateway ORIGIN, not the /api/v1 SDK path", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    const execute = spyOn(
      daemon,
      "executeClaimedAutomationRun"
    ).mockResolvedValue({
      itemsCollected: 0,
    });

    await withEnv("session-bearer", async () => {
      await automationExecuteCommand({
        workerId: "mac-abc",
        jobFile: envelopeFile(),
      });
    });

    // `/api/v1/api/workers/...` 404s — the worker API is mounted at the root.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]?.apiUrl).toBe("https://app.lobu.ai");
    // The claimer's own bearer and worker id are passed straight through.
    expect(execute.mock.calls[0]?.[0]?.workerId).toBe("mac-abc");
    expect(execute.mock.calls[0]?.[0]?.authToken).toBe("session-bearer");
  });

  test("refuses a missing --worker-id before touching the run", async () => {
    const execute = spyOn(
      daemon,
      "executeClaimedAutomationRun"
    ).mockResolvedValue({
      itemsCollected: 0,
    });

    await withEnv("session-bearer", async () => {
      await expect(
        automationExecuteCommand({ apiUrl: "https://app.lobu.ai" })
      ).rejects.toThrow(/--worker-id is required/);
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("refuses a missing WORKER_API_TOKEN before touching the run", async () => {
    const execute = spyOn(
      daemon,
      "executeClaimedAutomationRun"
    ).mockResolvedValue({
      itemsCollected: 0,
    });

    await withEnv(undefined, async () => {
      await expect(
        automationExecuteCommand({
          apiUrl: "https://app.lobu.ai",
          workerId: "mac-abc",
        })
      ).rejects.toThrow(/WORKER_API_TOKEN is required/);
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("a refusal carries exitCode 1 so the caller falls back to reporting", async () => {
    await withEnv(undefined, async () => {
      const error = await automationExecuteCommand({
        apiUrl: "https://app.lobu.ai",
        workerId: "mac-abc",
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect((error as { exitCode?: number } | null)?.exitCode).toBe(1);
    });
  });

  test("a REPORTED failure exits 0 — the outcome is already delivered", async () => {
    spyOn(daemon, "executeClaimedAutomationRun").mockResolvedValue({
      itemsCollected: 0,
      error: "agent CLI exited with non-zero status 1",
    });

    await withEnv("session-bearer", async () => {
      // Resolves rather than throwing: throwing would exit non-zero and make
      // the claiming bridge post a SECOND report for the same run.
      await expect(
        automationExecuteCommand({
          apiUrl: "https://app.lobu.ai",
          workerId: "mac-abc",
          jobFile: envelopeFile(),
        })
      ).resolves.toBeUndefined();
    });
  });

  test("rejects a malformed envelope without reporting anything", async () => {
    const execute = spyOn(
      daemon,
      "executeClaimedAutomationRun"
    ).mockResolvedValue({
      itemsCollected: 0,
    });

    await withEnv("session-bearer", async () => {
      await expect(
        automationExecuteCommand({
          apiUrl: "https://app.lobu.ai",
          workerId: "mac-abc",
          jobFile: envelopeFile("not json"),
        })
      ).rejects.toThrow(/not valid JSON/);
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

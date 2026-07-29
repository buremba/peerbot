import { afterEach, describe, expect, test } from "bun:test";
import { createGenericRuntimeBashOps } from "../embedded/runtime/generic-runtime-bash";

/**
 * An infrastructure failure must never look like a failed command.
 *
 * Production: a bare `echo hello > /tmp/x` came back "Status code 429 is not ok"
 * on stdout with exit 1, because the gateway flattened a provider rate limit
 * into the command's own result. The agent concluded its shell syntax was wrong,
 * rewrote a correct command and retried into an already-throttled endpoint.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function opsWithResponse(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  return createGenericRuntimeBashOps(
    { id: "vercel", remoteEnv: {} } as never,
    {
      gw: {
        gatewayUrl: "http://gateway.invalid",
        workerToken: "t",
        workspaceDir: "/workspace",
      },
    } as never
  );
}

async function run(ops: ReturnType<typeof createGenericRuntimeBashOps>) {
  const chunks: string[] = [];
  const result = await ops.exec("echo hello", "/", {
    onData: (c: Buffer | string) => chunks.push(c.toString()),
  } as never);
  return { output: chunks.join(""), exitCode: result.exitCode };
}

describe("generic runtime bash — infrastructure vs command failure", () => {
  test("a 429 is reported as the sandbox failing, not the command", async () => {
    const { output, exitCode } = await run(
      opsWithResponse(429, {
        error:
          "Sandbox runtime failed to run command: Status code 429 is not ok",
        kind: "infrastructure",
        retryable: true,
      })
    );

    // Not exit 1 — the command never ran, so it must not read as having failed.
    expect(exitCode).toBe(126);
    expect(output).toContain("sandbox runtime error");
    expect(output).toContain("your command did not run");
    // Retryable faults say so, so the agent waits instead of rewriting.
    expect(output).toContain("transient");
  });

  test("a non-retryable fault never claims the command did not run", async () => {
    // The log-fetch case: runCommand SUCCEEDED and only the output retrieval
    // failed. Telling the agent "your command did not run… retry" would make it
    // repeat a command that already took effect — a duplicated POST or append.
    const { output, exitCode } = await run(
      opsWithResponse(503, {
        error:
          "Sandbox runtime ran the command but could not retrieve its output: Status code 429 is not ok. The command MAY have completed — do not assume it needs re-running.",
        kind: "infrastructure",
        retryable: false,
      })
    );

    expect(exitCode).toBe(126);
    expect(output).toContain("sandbox runtime error");
    expect(output).toContain("outcome is unknown");
    expect(output).toContain("Do NOT re-run it blindly");
    // The two claims that would cause a duplicate side effect.
    expect(output).not.toContain("did not run");
    expect(output).not.toContain("transient");
  });

  test("an ordinary error response still reads as a command failure", async () => {
    const { output, exitCode } = await run(
      opsWithResponse(400, { error: "Missing command" })
    );

    expect(exitCode).toBe(1);
    expect(output).toContain("Missing command");
    expect(output).not.toContain("sandbox runtime error");
  });

  test("a command's own non-zero exit is passed through untouched", async () => {
    // The distinction only matters if real command failures survive it.
    const { output, exitCode } = await run(
      opsWithResponse(200, {
        stdout: "",
        stderr: "no such file\n",
        exitCode: 2,
      })
    );

    expect(exitCode).toBe(2);
    expect(output).toContain("no such file");
    expect(output).not.toContain("sandbox runtime error");
  });
});

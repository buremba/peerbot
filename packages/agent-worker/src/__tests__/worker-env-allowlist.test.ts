/**
 * The worker's own environment must not be readable from agent bash.
 *
 * Reproduced before the fix: with the two-entry denylist, `echo $ENCRYPTION_KEY`
 * returned the real value through the agent's shell under the STRICTEST posture
 * (cloud mode, no sandbox, no unsandboxed opt-in, zero spawned binaries
 * registered). Nothing had to escape a sandbox — `stripEnv` copied the whole
 * gateway env into the just-bash instance and removed only WORKER_TOKEN and
 * DISPATCHER_URL, so the values were simply there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmbeddedBashOps } from "../embedded/just-bash-bootstrap";
import { buildAgentEnv } from "../shared/worker-env-keys";

const tempDirs: string[] = [];
const TOUCHED = [
  "LOBU_EXEC_SANDBOX",
  "LOBU_ALLOW_UNSANDBOXED_EXEC",
  "LOBU_WORKSPACE_BACKEND",
  "ENCRYPTION_KEY",
  "JWT_SECRET",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "LOBU_AGENT_ENV_GREETING",
] as const;
const original = Object.fromEntries(
  TOUCHED.map((k) => [k, process.env[k]])
) as Record<string, string | undefined>;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const key of TOUCHED) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function echoFromAgentBash(varName: string): Promise<string> {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lobu-envleak-"))
  );
  tempDirs.push(workspace);
  // Strictest posture: no sandbox, no opt-in, nothing registered.
  process.env.LOBU_EXEC_SANDBOX = "off";
  delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
  delete process.env.LOBU_WORKSPACE_BACKEND;

  const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
  const chunks: string[] = [];
  await ops.exec(`echo $${varName}`, "/", {
    onData: (chunk) => chunks.push(chunk.toString()),
    timeout: 5,
  });
  return chunks.join("").trim();
}

describe("gateway secrets are not readable from agent bash", () => {
  test("REGRESSION: ENCRYPTION_KEY does not reach the agent's shell", async () => {
    process.env.ENCRYPTION_KEY = "vault-key-must-not-leak";
    expect(await echoFromAgentBash("ENCRYPTION_KEY")).toBe("");
  });

  test("REGRESSION: neither do the other gateway secrets", async () => {
    process.env.JWT_SECRET = "jwt-must-not-leak";
    process.env.DATABASE_URL = "postgres://must-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-must-not-leak";
    expect(await echoFromAgentBash("JWT_SECRET")).toBe("");
    expect(await echoFromAgentBash("DATABASE_URL")).toBe("");
    expect(await echoFromAgentBash("ANTHROPIC_API_KEY")).toBe("");
  });

  test("PATH still reaches the shell, or nothing resolves", async () => {
    expect(await echoFromAgentBash("PATH")).not.toBe("");
  });

  test("an explicitly-intended LOBU_AGENT_ENV_ value does reach it", async () => {
    process.env.LOBU_AGENT_ENV_GREETING = "hello-agent";
    expect(await echoFromAgentBash("LOBU_AGENT_ENV_GREETING")).toBe(
      "hello-agent"
    );
  });

  test("the connector-contributed GH_TOKEN lease reaches agent tooling", async () => {
    process.env.GH_TOKEN = "ghs_short_lived_lease";
    expect(await echoFromAgentBash("GH_TOKEN")).toBe("ghs_short_lived_lease");
  });
});

describe("buildAgentEnv", () => {
  test("keeps allowlisted names and drops everything else", () => {
    const out = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      GH_TOKEN: "ghs_short_lived_lease",
      NO_PROXY: "gateway,localhost",
      NIX_PACKAGES: "gh",
      JUST_BASH_ALLOWED_DOMAINS: '["github.com"]',
      ENCRYPTION_KEY: "nope",
      SOME_FUTURE_SECRET: "also nope",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/agent");
    expect(out.GH_TOKEN).toBe("ghs_short_lived_lease");
    expect(out.NIX_PACKAGES).toBe("gh");
    expect(out).not.toHaveProperty("NO_PROXY");
    expect(out).not.toHaveProperty("JUST_BASH_ALLOWED_DOMAINS");
    expect(out).not.toHaveProperty("ENCRYPTION_KEY");
    // The property that a denylist cannot have: a secret nobody has heard of
    // yet is excluded by default rather than included by default.
    expect(out).not.toHaveProperty("SOME_FUTURE_SECRET");
  });

  test("forwards NIX_PACKAGES so declared tooling is discoverable", () => {
    // Regression: the allowlist originally omitted NIX_PACKAGES. The gateway
    // set it correctly from the connector's declared packages, but the filter
    // dropped it before `discoverBinaries()` could read it — so a connector's
    // CLI was never registered and agent bash answered "gh: command not found"
    // while holding a perfectly good GH_TOKEN lease. Verified in production:
    // the credential arrived, the tool to spend it did not.
    const out = buildAgentEnv({
      NIX_PACKAGES: "gh,ripgrep",
      GH_TOKEN: "ghs_short_lived_lease",
    });
    expect(out.NIX_PACKAGES).toBe("gh,ripgrep");
    expect(out.GH_TOKEN).toBe("ghs_short_lived_lease");
  });

  test("drops the previously-denylisted keys too", () => {
    const out = buildAgentEnv({
      WORKER_TOKEN: "signed-token",
      DISPATCHER_URL: "https://dispatcher",
    });
    expect(out).not.toHaveProperty("WORKER_TOKEN");
    expect(out).not.toHaveProperty("DISPATCHER_URL");
  });

  test("`extra` passes through unfiltered — it is what the call site intends", () => {
    const out = buildAgentEnv(
      { ENCRYPTION_KEY: "nope" },
      { XDG_CONFIG_HOME: "/runtime/.config" }
    );
    expect(out.XDG_CONFIG_HOME).toBe("/runtime/.config");
    expect(out).not.toHaveProperty("ENCRYPTION_KEY");
  });

  test("undefined values never materialise as empty strings", () => {
    const out = buildAgentEnv(
      { PATH: undefined },
      { XDG_CONFIG_HOME: undefined }
    );
    expect(out).not.toHaveProperty("PATH");
    expect(out).not.toHaveProperty("XDG_CONFIG_HOME");
  });
});

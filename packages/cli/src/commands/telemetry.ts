import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { setLocalEnvValue } from "../internal/local-env.js";
import { parseEnvContent } from "../internal/env-file.js";

const SENTRY_DSN_DEFAULT =
  "https://c5910e58d1a134d64ff93a95a9c535bb@o4507291398897664.ingest.us.sentry.io/4511097466781696";

interface TelemetryOptions {
  cwd?: string;
}

async function loadEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, ".env"), "utf-8");
    return parseEnvContent(raw);
  } catch {
    return {};
  }
}

export async function telemetryStatusCommand(
  options: TelemetryOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const env = await loadEnv(cwd);
  const dsn = env.SENTRY_DSN ?? process.env.SENTRY_DSN;
  if (dsn) {
    console.log(chalk.green("\n  Telemetry: on"));
    console.log(chalk.dim(`  SENTRY_DSN: ${redactDsn(dsn)}\n`));
  } else {
    console.log(chalk.dim("\n  Telemetry: off"));
    console.log(chalk.dim("  No SENTRY_DSN configured.\n"));
  }
}

export async function telemetryOnCommand(
  options: TelemetryOptions & { dsn?: string } = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const dsn = options.dsn ?? SENTRY_DSN_DEFAULT;
  await setLocalEnvValue(cwd, "SENTRY_DSN", dsn);
  console.log(chalk.green("\n  Telemetry enabled."));
  console.log(chalk.dim(`  Wrote SENTRY_DSN to ${join(cwd, ".env")}\n`));
}

export async function telemetryOffCommand(
  options: TelemetryOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const envPath = join(cwd, ".env");
  let raw = "";
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    console.log(chalk.dim("\n  No .env to update — telemetry already off.\n"));
    return;
  }
  const filtered = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("SENTRY_DSN="))
    .join("\n");
  await writeFile(
    envPath,
    filtered.endsWith("\n") ? filtered : `${filtered}\n`
  );
  console.log(chalk.green("\n  Telemetry disabled."));
  console.log(chalk.dim(`  Removed SENTRY_DSN from ${envPath}\n`));
}

function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    // The Sentry public key (URL username) is genuinely public. Only
    // a deprecated DSN format includes a secret in the URL password.
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "***";
  }
}

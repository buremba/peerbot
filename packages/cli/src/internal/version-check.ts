import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOBU_CONFIG_DIR } from "./context.js";

const STATE_FILE = join(LOBU_CONFIG_DIR, "version-check.json");
const REGISTRY_URL = "https://registry.npmjs.org/@lobu/cli/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface State {
  lastCheck?: string;
  latestVersion?: string;
}

async function readState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as State;
  } catch {
    return {};
  }
}

async function writeState(state: State): Promise<void> {
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Hit the npm registry once a day to check for a newer @lobu/cli, store
 * the result, and return the latest version (or null on any failure).
 * Non-blocking: errors and timeouts are swallowed silently.
 */
async function fetchLatestIfStale(): Promise<string | null> {
  if (process.env.LOBU_DISABLE_UPDATE_CHECK === "1") return null;
  const state = await readState();
  const stale =
    !state.lastCheck ||
    Date.now() - Date.parse(state.lastCheck) > CHECK_INTERVAL_MS;

  if (!stale) {
    return state.latestVersion ?? null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    const latest = json.version ?? null;
    await writeState({
      lastCheck: new Date().toISOString(),
      latestVersion: latest ?? state.latestVersion,
    });
    return latest;
  } catch {
    // Burn the check window so we don't retry every command.
    await writeState({ ...state, lastCheck: new Date().toISOString() });
    return null;
  }
}

export async function maybePrintUpdateNotice(
  currentVersion: string
): Promise<void> {
  const latest = await fetchLatestIfStale();
  if (!latest) return;
  if (compareSemver(latest, currentVersion) <= 0) return;
  // Buffered to stderr so it never corrupts piped command output.
  const chalk = (await import("chalk")).default;
  process.stderr.write(
    chalk.dim(
      `\n  ${chalk.bold("@lobu/cli")} ${currentVersion} → ${chalk.green(latest)} available.\n` +
        `  Update: npm i -g @lobu/cli@latest  (or use npx @lobu/cli@latest)\n` +
        "  Disable: LOBU_DISABLE_UPDATE_CHECK=1\n\n"
    )
  );
}

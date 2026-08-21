import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Device identity charset accepted for `worker_id`. Mirrors the daemon's own
 * boot-time guard in `@lobu/connector-worker` so the CLI rejects an id the
 * daemon would reject anyway, before it reaches the cache or the gateway.
 */
export const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

/**
 * Per-context device state cache, persisted under `~/.lobu/devices/`.
 *
 * This is a LOCAL cache, never the source of truth: the server owns the device
 * row (`device_workers.organization_id`) and its identity (`(user_id,
 * worker_id)`). Its only job is to make a repeated `lobu daemon` on the same
 * machine reuse the same confirmed worker id, so a restart does not silently
 * churn into a second device. Only `workerId` is stored.
 */
export interface DeviceState {
  /** The confirmed `worker_id` passed to the daemon on every run. */
  workerId: string;
}

function devicesDir(): string {
  return join(homedir(), ".lobu", "devices");
}

function statePath(context: string): string {
  const safe = context.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(devicesDir(), `${safe}.json`);
}

function parseDeviceState(raw: string): DeviceState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceState>;
    if (
      typeof parsed.workerId !== "string" ||
      !WORKER_ID_PATTERN.test(parsed.workerId)
    ) {
      return null;
    }
    return { workerId: parsed.workerId };
  } catch {
    return null;
  }
}

export async function loadDeviceState(
  context: string
): Promise<DeviceState | null> {
  try {
    return parseDeviceState(await readFile(statePath(context), "utf-8"));
  } catch {
    // Absent, unreadable, or unparseable all mean the same thing to the caller:
    // there is no confirmed identity yet, so fall through to setup.
    return null;
  }
}

/**
 * Atomically persist the first valid identity for a context.
 *
 * Concurrent first boots serialize through an owner-only lock and all return
 * the same winner. A corrupt prior payload is moved aside for diagnosis before
 * the replacement is renamed into place; no reader can observe a partial JSON
 * write.
 */
export async function saveDeviceState(
  context: string,
  state: DeviceState
): Promise<DeviceState> {
  if (!WORKER_ID_PATTERN.test(state.workerId)) {
    throw new Error(`invalid device worker id '${state.workerId}'`);
  }

  const dir = devicesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const path = statePath(context);
  const existing = await loadDeviceState(context);
  if (existing) return existing;

  const lockPath = `${path}.lock`;
  const lock = await acquireLock(lockPath);
  let tempPath: string | undefined;
  try {
    const winner = await loadDeviceState(context);
    if (winner) return winner;

    try {
      await stat(path);
      await rename(path, `${path}.corrupt-${randomUUID()}`);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    tempPath = `${path}.${randomUUID()}.tmp`;
    const temp = await open(tempPath, "wx", 0o600);
    try {
      await temp.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf-8");
      await temp.sync();
    } finally {
      await temp.close();
    }
    await rename(tempPath, path);
    tempPath = undefined;
    await chmod(path, 0o600);
    return state;
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquireLock(
  lockPath: string
): Promise<Awaited<ReturnType<typeof open>>> {
  const started = Date.now();
  while (true) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for concurrent device setup (${lockPath})`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Longest stem shown for a worker PAT: `owl_pat_` plus four secret chars. */
const TOKEN_PREFIX_LENGTH = 12;

/**
 * A short stem of a worker PAT, so the user can confirm *which* token a device
 * booted with without the terminal echoing the secret.
 *
 * Never returns the token whole. A real PAT is `owl_pat_` + 24 random chars, so
 * the stem always drops most of it; a value too short to truncate is malformed
 * rather than a usable credential, and is reported as such instead of printed.
 */
export function workerTokenPrefix(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= TOKEN_PREFIX_LENGTH) return null;
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-context device state cache, persisted under `~/.lobu/devices/`.
 *
 * This is a LOCAL cache, never the source of truth: the server owns the device
 * row (`device_workers.organization_id`) and its identity (`(user_id,
 * worker_id)`). Its only job is to make a repeated `lobu daemon` on the same
 * machine reuse the same confirmed worker id, so a restart does not silently
 * churn into a second device. Only `workerId` is stored — nothing else is read
 * back on load.
 */
export interface DeviceState {
  /** The confirmed `worker_id` passed to the daemon on every run. */
  workerId: string;
}

function statePath(context: string): string {
  const safe = context.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".lobu", "devices", `${safe}.json`);
}

export async function loadDeviceState(
  context: string
): Promise<DeviceState | null> {
  try {
    const raw = await readFile(statePath(context), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeviceState>;
    if (typeof parsed.workerId !== "string" || parsed.workerId.length === 0) {
      return null;
    }
    return { workerId: parsed.workerId };
  } catch {
    return null;
  }
}

export async function saveDeviceState(
  context: string,
  state: DeviceState
): Promise<DeviceState> {
  await mkdir(join(homedir(), ".lobu", "devices"), { recursive: true });
  await writeFile(statePath(context), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function workerTokenPrefix(token: string | undefined): string | null {
  if (!token) return null;
  return token.length > 12 ? token.slice(0, 12) : token;
}

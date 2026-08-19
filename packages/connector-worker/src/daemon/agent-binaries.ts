/**
 * Local agent CLI discovery.
 *
 * Two consumers:
 *   - the automation arm, which resolves the binary it is about to spawn;
 *   - the poll loop, which advertises `agent_kinds` so the gateway can withhold
 *     an Automation run from a device that cannot execute it.
 *
 * Those have to agree. Advertising the static `AGENT_KINDS` list would say
 * "this build knows about five CLIs", not "this machine has them" — the run
 * would still be claimed and then fail locally with "binary not found on PATH",
 * which is exactly the outcome the gateway gate exists to prevent.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import { DEVICE_AGENT_SPECS } from '@lobu/core/contracts/worker/device-automation';

/** Search prefixes for CLI discovery — mirrors the Mac app's detector list. */
export function searchDirs(): string[] {
  const home = homedir();
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * `dirs` overrides the discovery path. Production never passes it — the default
 * is the fixed prefixes plus `$PATH`, because a GUI-launched daemon inherits a
 * minimal `$PATH` that omits every one of them.
 */
export function locateBinary(name: string, dirs?: string[]): string | null {
  const search = dirs ?? [
    ...searchDirs(),
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
  ];
  for (const dir of search) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The agent kinds this machine can actually spawn right now, in
 * `DEVICE_AGENT_SPECS` order.
 *
 * `overrides` is the executor's `binaryOverrides` map: an explicit path wins
 * over PATH discovery, matching how the arm resolves the binary at spawn time,
 * but it still has to exist — an override pointing at a deleted file must not
 * make the device claim runs it will fail.
 */
export function resolveRunnableAgentKinds(
  overrides?: Partial<Record<AgentKind, string>>,
  dirs?: string[]
): AgentKind[] {
  return DEVICE_AGENT_SPECS.filter((spec) => {
    const override = overrides?.[spec.kind];
    if (override) return existsSync(override);
    return locateBinary(spec.binaryName, dirs) !== null;
  }).map((spec) => spec.kind);
}

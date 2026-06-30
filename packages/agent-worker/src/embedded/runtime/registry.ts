import type { WorkerRuntimeProvider } from "./types";

/**
 * Worker-side runtime-provider registry. Selection is a single map lookup
 * keyed on `LOBU_RUNTIME_PROVIDER` — no per-provider `if` branches, no
 * duplicated selector strings.
 */
const REGISTRY = new Map<string, WorkerRuntimeProvider>();

export function registerWorkerRuntimeProvider(
  provider: WorkerRuntimeProvider
): void {
  REGISTRY.set(provider.id.toLowerCase(), provider);
}

/** Returns the provider for `id`, or undefined → fall back to local just-bash. */
export function getWorkerRuntimeProvider(
  id: string | undefined | null
): WorkerRuntimeProvider | undefined {
  if (!id) return undefined;
  return REGISTRY.get(id.trim().toLowerCase());
}

import type { GatewayRuntimeProvider } from "./types.js";

/**
 * Gateway-side runtime-provider registry. The route resolves a provider by the
 * token's `runtimeProviderId` claim — one map lookup, no provider branches.
 */
const REGISTRY = new Map<string, GatewayRuntimeProvider>();

export function registerGatewayRuntimeProvider(
  provider: GatewayRuntimeProvider
): void {
  REGISTRY.set(provider.id.toLowerCase(), provider);
}

export function getGatewayRuntimeProvider(
  id: string | undefined | null
): GatewayRuntimeProvider | undefined {
  if (!id) return undefined;
  return REGISTRY.get(id.trim().toLowerCase());
}

/** Registered provider ids — the set of connectable sandbox providers. */
export function listGatewayRuntimeProviderIds(): string[] {
  return [...REGISTRY.keys()];
}

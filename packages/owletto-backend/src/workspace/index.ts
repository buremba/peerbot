import { MultiTenantProvider } from './multi-tenant';
import type { WorkspaceProvider } from './types';

let provider: WorkspaceProvider | null = null;

/**
 * Create and initialize the workspace provider.
 * Called once at server startup.
 */
export async function initWorkspaceProvider(): Promise<WorkspaceProvider> {
  if (provider) return provider;

  provider = new MultiTenantProvider();
  await provider.init();
  return provider;
}

/**
 * Get the initialized workspace provider.
 * Throws if called before initWorkspaceProvider().
 */
export function getWorkspaceProvider(): WorkspaceProvider {
  if (!provider) {
    throw new Error('WorkspaceProvider not initialized. Call initWorkspaceProvider() first.');
  }
  return provider;
}

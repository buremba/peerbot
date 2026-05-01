import { AsyncLocalStorage } from 'node:async_hooks';

interface OrgContext {
  organizationId: string;
}

export const orgContext = new AsyncLocalStorage<OrgContext>();

export function getOrgId(): string {
  const ctx = orgContext.getStore();
  if (!ctx)
    throw new Error('Organization context not available — wrap request with orgContext.run()');
  return ctx.organizationId;
}

export function tryGetOrgId(): string | null {
  return orgContext.getStore()?.organizationId ?? null;
}

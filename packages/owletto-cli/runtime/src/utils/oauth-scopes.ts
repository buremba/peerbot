export function normalizeScopeList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\s,]+/)
          .map((part) => part.trim())
          .filter(Boolean)
      : [];

  return Array.from(
    new Set(raw.filter((scope): scope is string => typeof scope === 'string').map((s) => s.trim()))
  ).filter(Boolean);
}

export function hasAllScopes(granted: Iterable<string>, required: Iterable<string>): boolean {
  const grantedSet = new Set(
    Array.from(granted)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
  for (const scope of required) {
    const normalized = scope.trim();
    if (!normalized) continue;
    if (!grantedSet.has(normalized)) return false;
  }
  return true;
}

export function readRequestedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.requested_scopes);
}

export function readGrantedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.granted_scopes);
}

export function mergeOAuthScopeAuthData(
  authData: Record<string, unknown> | null | undefined,
  params: {
    requestedScopes?: string[] | null;
    grantedScopes?: string[] | null;
    identity?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  return {
    ...(authData ?? {}),
    ...(params.requestedScopes
      ? { requested_scopes: normalizeScopeList(params.requestedScopes) }
      : {}),
    ...(params.grantedScopes ? { granted_scopes: normalizeScopeList(params.grantedScopes) } : {}),
    ...(params.identity ? { identity: params.identity } : {}),
  };
}

export function getFeedRequiredScopes(
  feedsSchema: Record<string, unknown> | null | undefined,
  feedKey: string
): string[] {
  if (!feedsSchema || typeof feedsSchema !== 'object' || Array.isArray(feedsSchema)) return [];
  const byKey = (feedsSchema as Record<string, Record<string, unknown>>)[feedKey];
  if (byKey && typeof byKey === 'object') {
    return normalizeScopeList(byKey.requiredScopes);
  }

  for (const value of Object.values(feedsSchema as Record<string, Record<string, unknown>>)) {
    if (value && typeof value === 'object' && value.key === feedKey) {
      return normalizeScopeList((value as Record<string, unknown>).requiredScopes);
    }
  }

  return [];
}

import type { Context } from 'hono';
import type { Env } from '../index';

/**
 * Widened `next` for `resolveAuth`.
 *
 * Hono's own `Next` is `() => Promise<void>`. That's correct when `mcpAuth`
 * is used as `app.use('/path', mcpAuth)` — the inner handler chain returns
 * void.
 *
 * `mcpAuth` is also used as `mcpAuth(c, async () => { ...; return c.json(...); })`
 * (see the `/api/workers/*` gating middleware in `index.ts`) — the cb may
 * short-circuit by returning a `Response`. If `resolveAuth`'s `next` is
 * typed as `Promise<void>`, TypeScript collapses the cb's Response return
 * type, the helpers inside `resolveAuth` infer `Promise<void>`, and every
 * caller has to choose between discarding the cb's return (silent 500s —
 * see Bug B fix doc) or fighting the type checker.
 *
 * Widening to `Promise<Response | void>` lets the cb's `Response` flow back
 * through `setContextAndContinue → next()` and out to Hono's `dispatch`
 * which sets `c.res` correctly.
 */
export type ResolveAuthNext = () => Promise<Response | void>;

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  description: string | null;
  created_at: string;
  is_member: boolean;
  visibility: 'public' | 'private';
}

export interface AuthConfigData {
  social: Record<string, boolean>;
  magicLink: boolean;
  phone: boolean;
  emailPassword: boolean;
}

export type HonoContext = Context<{ Bindings: Env }>;

export interface ResolvedOwner {
  slug: string;
  type: 'user' | 'organization';
  id: string;
  name: string | null;
}

export interface WorkspaceProvider {
  /** Initialize provider (called once at startup) */
  init(): Promise<void>;

  /** Hono middleware: resolve auth + workspace context for a request */
  resolveAuth(c: HonoContext, next: ResolveAuthNext): Promise<Response | undefined>;

  /** List organizations the user is a member of */
  listOrganizations(search?: string, userId?: string | null): Promise<OrgInfo[]>;

  /** Auth config for frontend */
  getAuthConfig(env: Env): Promise<AuthConfigData>;

  /** Resolve org slug from org ID */
  getOrgSlug(orgId: string): Promise<string | null>;

  /**
   * Batch resolve org slugs from org IDs.
   * Returns a map of orgId -> slug.
   */
  getOrgSlugs(orgIds: string[]): Promise<Map<string, string>>;

  /** Resolve an owner (namespace) by slug and type */
  resolveOwner(slug: string, type: 'user' | 'organization'): Promise<ResolvedOwner | null>;
}

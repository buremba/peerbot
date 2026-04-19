import type { Context, Next } from 'hono';
import type { Env } from '../index';

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
  resolveAuth(c: HonoContext, next: Next): Promise<Response | undefined>;

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

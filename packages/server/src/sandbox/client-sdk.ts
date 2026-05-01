/**
 * In-process SDK shared by the `query` / `run` MCP tools and watcher reactions.
 * `mode: "read"` filters namespaces against `METHOD_METADATA[*].access === "read"`;
 * `allowCrossOrg: false` makes `client.org(...)` throw `CrossOrgAccessDenied`.
 */

import { hasRequiredMcpScope } from "../auth/tool-access";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";
import { raceAbort } from "../utils/race-abort";
import {
  getCachedMembershipRole,
  getCachedOrgBySlug,
  getOrgById,
} from "../workspace/multi-tenant";
import { METHOD_METADATA } from "./method-metadata";
import type { SDKMode } from "./sdk-manifest";

export { type SDKMode, enumerateSDKManifest } from "./sdk-manifest";
import {
  buildAuthProfilesNamespace,
  buildClassifiersNamespace,
  buildConnectionsNamespace,
  buildEntitiesNamespace,
  buildEntitySchemaNamespace,
  buildFeedsNamespace,
  buildKnowledgeNamespace,
  buildOperationsNamespace,
  buildOrganizationsNamespace,
  buildViewTemplatesNamespace,
  buildWatchersNamespace,
} from "./namespaces";
import type { AuthProfilesNamespace } from "./namespaces/auth-profiles";
import type { ClassifiersNamespace } from "./namespaces/classifiers";
import type { ConnectionsNamespace } from "./namespaces/connections";
import type { EntitiesNamespace } from "./namespaces/entities";
import type { EntitySchemaNamespace } from "./namespaces/entity-schema";
import type { FeedsNamespace } from "./namespaces/feeds";
import type { KnowledgeNamespace } from "./namespaces/knowledge";
import type { OperationsNamespace } from "./namespaces/operations";
import type { OrganizationsNamespace } from "./namespaces/organizations";
import type { ViewTemplatesNamespace } from "./namespaces/view-templates";
import type { WatchersNamespace } from "./namespaces/watchers";

export interface ClientSDK {
  entities: EntitiesNamespace;
  entitySchema: EntitySchemaNamespace;
  connections: ConnectionsNamespace;
  feeds: FeedsNamespace;
  authProfiles: AuthProfilesNamespace;
  operations: OperationsNamespace;
  watchers: WatchersNamespace;
  classifiers: ClassifiersNamespace;
  viewTemplates: ViewTemplatesNamespace;
  knowledge: KnowledgeNamespace;
  organizations: OrganizationsNamespace;

  org(slugOrId: string): Promise<ClientSDK>;
  query(sql: string): Promise<unknown[]>;
  log(message: string, data?: Record<string, unknown>): void;
}

export class SdkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class AccessDeniedError extends SdkError {
  constructor(message: string) {
    super("AccessDenied", message);
  }
}

export class OrgNotFoundError extends SdkError {
  constructor(message: string) {
    super("OrgNotFound", message);
  }
}

export class CrossOrgAccessDenied extends SdkError {
  constructor(message: string) {
    super("CrossOrgAccessDenied", message);
  }
}

export interface ResolvedOrgMembership {
  orgId: string;
  slug: string;
  role: string | null;
  visibility: "public" | "private";
}

export async function resolveOrgMembership(
  slugOrId: string,
  ctx: ToolContext,
): Promise<ResolvedOrgMembership> {
  let orgId: string;
  let slug: string;
  let visibility: "public" | "private";

  const bySlug = await getCachedOrgBySlug(slugOrId);
  if (bySlug) {
    orgId = bySlug.id;
    slug = slugOrId;
    visibility = bySlug.visibility === "public" ? "public" : "private";
  } else {
    const byId = await getOrgById(slugOrId);
    if (!byId) {
      throw new OrgNotFoundError(`Organization '${slugOrId}' not found.`);
    }
    orgId = slugOrId;
    slug = byId.slug;
    visibility = byId.visibility === "public" ? "public" : "private";
  }

  const role = await getCachedMembershipRole(orgId, ctx.userId);

  if (visibility === "private" && role === null) {
    throw new AccessDeniedError(
      `You are not a member of organization '${slug}'.`,
    );
  }

  return { orgId, slug, role, visibility };
}

function isSystemContext(ctx: ToolContext): boolean {
  return ctx.isAuthenticated === true && ctx.userId === null && ctx.memberRole === null;
}

export interface BuildClientSDKOptions {
  mode?: SDKMode;
  allowCrossOrg?: boolean;
  /**
   * Forwarded onto every handler's `ToolContext.abortSignal`. Handlers that
   * opt in (e.g. `query_sql` / `client.query`) race their work against this
   * signal so the awaiting caller unblocks immediately on script timeout.
   * The underlying postgres connection isn't cancelled — see
   * `ToolContext.abortSignal` for the full caveat.
   */
  abortSignal?: AbortSignal;
}

export function buildClientSDK(
  ctx: ToolContext,
  env: Env,
  opts?: BuildClientSDKOptions,
): ClientSDK {
  const mode: SDKMode = opts?.mode ?? "full";
  const allowCrossOrg = opts?.allowCrossOrg ?? ctx.allowCrossOrg ?? false;
  const ctxWithSignal: ToolContext = opts?.abortSignal
    ? { ...ctx, abortSignal: opts.abortSignal }
    : ctx;
  ctx = ctxWithSignal;

  const namespaces = {
    entities: buildEntitiesNamespace(ctx, env),
    entitySchema: buildEntitySchemaNamespace(ctx, env),
    connections: buildConnectionsNamespace(ctx, env),
    feeds: buildFeedsNamespace(ctx, env),
    authProfiles: buildAuthProfilesNamespace(ctx, env),
    operations: buildOperationsNamespace(ctx, env),
    watchers: buildWatchersNamespace(ctx, env),
    classifiers: buildClassifiersNamespace(ctx, env),
    viewTemplates: buildViewTemplatesNamespace(ctx, env),
    knowledge: buildKnowledgeNamespace(ctx, env),
    organizations: buildOrganizationsNamespace(ctx),
  };

  if (mode === "read") {
    for (const [ns, namespace] of Object.entries(namespaces)) {
      // Drop methods missing a metadata entry or marked write/external.
      // The Proxy in run-script.ts then advertises only the survivors.
      const record = namespace as unknown as Record<string, unknown>;
      for (const method of Object.keys(record)) {
        if (METHOD_METADATA[`${ns}.${method}`]?.access !== "read") {
          delete record[method];
        }
      }
      Object.freeze(namespace);
    }
  }

  const sdk: ClientSDK = {
    ...namespaces,

    async org(slugOrId) {
      if (!allowCrossOrg) {
        throw new CrossOrgAccessDenied(
          "Cross-org access is not available on this connection. Use the unscoped /mcp endpoint with an OAuth session, or reconnect to /mcp/{slug} for the target workspace.",
        );
      }
      const member = await resolveOrgMembership(slugOrId, ctx);
      return buildClientSDK(
        { ...ctx, organizationId: member.orgId, memberRole: member.role },
        env,
        { mode, allowCrossOrg, abortSignal: ctx.abortSignal },
      );
    },

    async query(querySql) {
      // The SQL allowlist exposes audit/event tables — admin/owner only for
      // user sessions; system contexts (watcher reactions) bypass this gate.
      if (!isSystemContext(ctx)) {
        if (ctx.memberRole !== "owner" && ctx.memberRole !== "admin") {
          throw new AccessDeniedError(
            "client.query requires admin or owner access in the current organization.",
          );
        }
        if (!hasRequiredMcpScope("admin", ctx.scopes)) {
          throw new AccessDeniedError(
            "client.query requires an MCP session with admin access.",
          );
        }
      }
      const [{ getDb }, { validateAndScopeQuery }] = await Promise.all([
        import("../db/client"),
        import("../utils/execute-data-sources"),
      ]);
      const scoped = validateAndScopeQuery(querySql, ctx.organizationId);
      const rows = await raceAbort(
        getDb().begin(async (tx) => {
          await tx.unsafe("SET TRANSACTION READ ONLY");
          await tx.unsafe("SET LOCAL statement_timeout = '5000'");
          return tx.unsafe(scoped.sql, scoped.params as unknown[]);
        }),
        ctx.abortSignal,
      );
      return rows.map((r: Record<string, unknown>) => ({ ...r }));
    },

    log(message, data) {
      // biome-ignore lint/suspicious/noConsole: structured-log fallback; routes through Sentry breadcrumbs in prod.
      console.log(`[client-sdk] ${message}`, data ?? {});
    },
  };

  if (mode === "read") Object.freeze(sdk);
  return sdk;
}

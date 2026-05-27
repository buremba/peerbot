/**
 * Tool-surface eval — scenario backing.
 *
 * Boots the REAL Lobu MCP tool handlers against a real Postgres (via the
 * server package's test fixtures), seeds the CRM `lead`/`pilot` entity types
 * and a deterministic starting pipeline, and exposes a typed dispatcher that
 * runs any MCP tool by name through its real handler — the same handlers the
 * cloud gateway invokes. Both eval arms share this backing so the only thing
 * that differs between them is the SHAPE of the tool surface presented to
 * glm-4.7 (discrete tools vs. one bash + MCP-as-CLI), not the implementation.
 *
 * No isolated-vm: we import the REST/admin handlers + search/save directly and
 * never touch `run_sdk`/`query_sdk` (those need the sandbox). The discrete
 * tool LIST still advertises them so the model sees the true ~23-tool surface;
 * if it picks one, the dispatcher returns a clear error and we score a fumble.
 */

import type { Sql } from "postgres";
import { manageEntity } from "../../../../packages/server/src/tools/admin/manage_entity";
import { manageEntitySchema } from "../../../../packages/server/src/tools/admin/manage_entity_schema";
import {
  listWatchers,
  manageWatchers,
} from "../../../../packages/server/src/tools/admin/manage_watchers";
import { querySql } from "../../../../packages/server/src/tools/admin/query_sql";
import { saveContent } from "../../../../packages/server/src/tools/save_content";
import { search } from "../../../../packages/server/src/tools/search";
import { getAllTools } from "../../../../packages/server/src/tools/registry";
import type { Env } from "../../../../packages/server/src/index";
import type { ToolContext } from "../../../../packages/server/src/tools/registry";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from "../../../../packages/server/src/__tests__/setup/test-fixtures";
import { setupTestDatabase } from "../../../../packages/server/src/__tests__/setup/test-db";
import { getTestDb } from "../../../../packages/server/src/__tests__/setup/test-db";
import { initWorkspaceProvider } from "../../../../packages/server/src/workspace";

const ENV: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: "test-jwt-secret-for-testing-only",
  BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
  MAX_CONSECUTIVE_FAILURES: "3",
  RATE_LIMIT_ENABLED: "false",
};

export interface ScenarioOrg {
  org: { id: string; slug: string; name: string };
  ctx: ToolContext;
}

/** Tools that need the isolated-vm sandbox; unreachable in this harness. */
const SANDBOX_TOOLS = new Set(["run_sdk", "query_sdk", "search_sdk"]);

// Track migration and connection state separately. A single shared flag would
// let an earlier connect-only init (`ensureConnected`) mark setup "done" and
// silently skip the destructive migration step a later `ensureMigrated` needs.
let migrated = false;
let connected = false;

/** Run migrations once against the test DB, then bring up the workspace provider. */
export async function ensureMigrated(): Promise<void> {
  if (!migrated) {
    await setupTestDatabase();
    migrated = true;
  }
  if (!connected) {
    await initWorkspaceProvider();
    connected = true;
  }
}

/**
 * Connect-only init for child processes that share a DB already migrated by the
 * parent. Skips the destructive DROP SCHEMA + migrations; just brings up the
 * workspace provider so URL-building handlers work. Does NOT set `migrated`, so
 * a later `ensureMigrated()` in the same process still runs migrations.
 */
export async function ensureConnected(): Promise<void> {
  if (connected) return;
  await initWorkspaceProvider();
  connected = true;
}

export function db(): Sql {
  return getTestDb();
}

/**
 * Build the discrete MCP tool list exactly as the cloud worker would see it
 * (names + descriptions + JSON schemas). This is the Arm-A surface.
 */
export function discreteToolDefs() {
  return getAllTools({ includeInternalTools: true });
}

/**
 * The single dispatcher both arms route through. Maps a tool name + args to its
 * real handler. Throws a ToolUserError-shaped Error for unsupported tools so the
 * model gets a real failure (and we score a fumble) rather than a silent no-op.
 */
export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (SANDBOX_TOOLS.has(toolName)) {
    throw new Error(
      `${toolName} is not available in this environment. Use manage_entity / save_memory / query_sql / search_memory instead.`
    );
  }
  switch (toolName) {
    case "manage_entity":
      return manageEntity(args as never, ENV, ctx);
    case "manage_entity_schema":
      return manageEntitySchema(args as never, ENV, ctx);
    case "manage_watchers":
      return manageWatchers(args as never, ENV, ctx);
    case "list_watchers":
      return listWatchers(args as never, ENV, ctx);
    case "query_sql":
      return querySql(args as never, ENV, ctx);
    case "save_memory":
      return saveContent(args as never, ENV, ctx);
    case "search_memory":
      return search(args as never, ENV, ctx);
    default:
      throw new Error(
        `Tool "${toolName}" is not supported in this eval harness. ` +
          `Supported: manage_entity, manage_entity_schema, save_memory, search_memory, query_sql, manage_watchers, list_watchers.`
      );
  }
}

/** Create a fresh org + owner, seed CRM entity types. Returns the auth ctx. */
export async function freshOrg(name: string): Promise<ScenarioOrg> {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, "owner");
  const ctx: ToolContext = {
    organizationId: org.id,
    userId: user.id,
    memberRole: "owner",
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    tokenType: "oauth",
    scopedToOrg: true,
    allowCrossOrg: false,
  };

  // Seed the two CRM entity types the crm-ops skill defines.
  await manageEntitySchema(
    {
      schema_type: "entity_type",
      action: "create",
      slug: "lead",
      name: "Lead",
      description:
        "A funnel lead. Funnel stages live on metadata.stage: signal -> trial -> conversation -> pilot -> customer (plus cold).",
      metadata_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          company: { type: "string" },
          source: { type: "string" },
          stage: {
            type: "string",
            enum: [
              "signal",
              "trial",
              "conversation",
              "pilot",
              "customer",
              "cold",
            ],
          },
          github_handle: { type: "string" },
          x_handle: { type: "string" },
          email: { type: "string" },
          notes: { type: "string" },
        },
      },
      event_kinds: {
        "lead:created": { description: "Lead first tracked" },
        "lead:interaction": { description: "A touchpoint with the lead" },
        "lead:stage_changed": { description: "Funnel stage advanced" },
      },
    } as never,
    ENV,
    ctx
  );

  await manageEntitySchema(
    {
      schema_type: "entity_type",
      action: "create",
      slug: "pilot",
      name: "Pilot",
      description: "A paid pilot opened from a converted lead.",
      event_kinds: {
        "pilot:created": { description: "Pilot opened" },
        "pilot:status_changed": { description: "Pilot status changed" },
      },
      metadata_schema: {
        type: "object",
        properties: {
          company: { type: "string" },
          seats: { type: "number" },
          mrr: { type: "number" },
          status: {
            type: "string",
            enum: ["active", "won", "lost", "paused"],
          },
          start_date: { type: "string" },
          success_metric: { type: "string" },
          lead_id: { type: "number" },
        },
      },
    } as never,
    ENV,
    ctx
  );

  // The "converted-to" relationship type (lead -> pilot).
  await manageEntitySchema(
    {
      schema_type: "relationship_type",
      action: "create",
      slug: "converted-to",
      name: "Converted to",
      description: "Links a lead to the pilot it became.",
    } as never,
    ENV,
    ctx
  );

  return { org, ctx };
}

/** Directly insert a lead entity (bypasses the agent) for seeding fixtures. */
export async function seedLead(
  ctx: ScenarioOrg,
  lead: {
    name: string;
    company: string;
    source: string;
    stage: string;
    github_handle?: string;
    email?: string;
    notes?: string;
  }
): Promise<number> {
  // Name the entity "<Person> — <Company>" so the fuzzy/trigram name search in
  // `search_memory` (which matches on entity.name, not metadata) finds the lead
  // by either term. Without this, no-embeddings local search returns empty for a
  // company query and weaker models bail after the first lookup — an artifact of
  // the harness, not the tool surface. The metadata.company field stays exact.
  const res = (await manageEntity(
    {
      action: "create",
      entity_type: "lead",
      name: `${lead.name} — ${lead.company}`,
      metadata: {
        name: lead.name,
        company: lead.company,
        source: lead.source,
        stage: lead.stage,
        ...(lead.github_handle && { github_handle: lead.github_handle }),
        ...(lead.email && { email: lead.email }),
        ...(lead.notes && { notes: lead.notes }),
      },
    } as never,
    ENV,
    ctx.ctx
  )) as { entity?: { id?: number }; id?: number };
  const id = res.entity?.id ?? res.id;
  if (typeof id !== "number") {
    throw new Error(
      `seedLead: could not resolve entity id from ${JSON.stringify(res)}`
    );
  }
  return id;
}

/**
 * Save an interaction event for a lead at a controlled timestamp. Used to seed
 * the "stale leads" task with deterministic last-touch dates.
 */
export async function seedInteraction(
  ctx: ScenarioOrg,
  entityId: number,
  summary: string,
  occurredAt: Date
): Promise<void> {
  await saveContent(
    {
      content: summary,
      semantic_type: "lead:interaction",
      entity_ids: [entityId],
      occurred_at: occurredAt.toISOString(),
      metadata: {},
    } as never,
    ENV,
    ctx.ctx
  );
}

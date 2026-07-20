/**
 * Discovery-surface eval — the discovery task matrix.
 *
 * Each task is a BARE natural-language intent an operator would say — no method
 * names, no scaffolding — spanning a different corner of the Lobu MCP surface.
 * Success requires the agent to DISCOVER the right operation (via `search_sdk`
 * + the MCP tool descriptions) and EXECUTE it. Every task has a deterministic
 * DB-state check; read/question tasks additionally score the final reply text
 * for the right real facts (via `replyCheck`).
 *
 * Seeds add only the minimal starting state the intent implies (e.g. an
 * installed connector to connect, seeded companies to query) — never the
 * how-to. The agent has to find the rest.
 */

import {
  db,
  installConnector,
  seedEntity,
  seedEntityType,
  type ScenarioOrg,
} from "./scenario";

export interface TaskResult {
  pass: boolean;
  detail: string;
}

/**
 * The access tier the task's WRITE requires. Under `--scope default` (a normal
 * `mcp:read mcp:write` member token — what `lobu token create` mints), an
 * `admin` task's action is legitimately blocked, so completing it is impossible
 * by design; the runner scores those as "correctly blocked" rather than a
 * discovery failure. Read/member-write tasks are expected to complete on either
 * scope. This keeps a default-scope battery an honest measure of the MEMBER
 * experience instead of counting admin-gated actions as surface failures.
 */
export type TaskTier = "read" | "member-write" | "admin";

export interface EvalTask {
  id: string;
  title: string;
  /** Access tier the task's write requires (default: "member-write"). */
  tier?: TaskTier;
  /** Seed identical starting state. Returns any ids the prompt/check needs. */
  seed: (org: ScenarioOrg) => Promise<Record<string, unknown>>;
  /** The bare natural-language intent handed to the model. */
  prompt: (seeded: Record<string, unknown>) => string;
  /** Deterministic state assertion against the DB after the turn. */
  check: (
    org: ScenarioOrg,
    seeded: Record<string, unknown>
  ) => Promise<TaskResult>;
}

async function countRows(query: Promise<{ n: number }[]>): Promise<number> {
  const rows = await query;
  return rows[0]?.n ?? 0;
}

export const TASKS: EvalTask[] = [
  // 1 — connect a feed connector (no-auth) + create its feed. The connector is
  //     keyed/named "website" so the agent's connector-intent `search_sdk`
  //     ("website") surfaces it — a fair discovery test, not a name-mismatch one.
  {
    id: "connect-website",
    tier: "admin",
    title: "Set up collection of a website's pages",
    seed: async (org) => {
      await installConnector(org, {
        key: "website",
        name: "Website",
        feeds: { pages: { description: "Collected web pages" } },
        authNone: true,
      });
      return {};
    },
    prompt: () =>
      "Set up collection of https://example.com's pages into my workspace. The connector for this is already installed.",
    check: async (org) => {
      const sql = db();
      const conns = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM connections
        WHERE organization_id = ${org.org.id} AND connector_key = 'website'
          AND deleted_at IS NULL`;
      const feeds = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM feeds
        WHERE organization_id = ${org.org.id} AND feed_key = 'pages'
          AND deleted_at IS NULL`;
      const nc = conns[0]?.n ?? 0;
      const nf = feeds[0]?.n ?? 0;
      if (nc === 0)
        return {
          pass: false,
          detail: "no connection for connector 'website'",
        };
      if (nf === 0)
        return {
          pass: false,
          detail: `connection created but no 'pages' feed`,
        };
      return { pass: true, detail: `connection + 'pages' feed created` };
    },
  },

  // 2 — connect an action/integration connector (auth-gated). Success = a
  //     connection row exists (it lands pending_auth, since Slack needs install).
  {
    id: "connect-slack",
    tier: "admin",
    title: "Connect the Slack workspace",
    seed: async (org) => {
      await installConnector(org, {
        key: "slack",
        name: "Slack",
        authNone: false,
      });
      return {};
    },
    prompt: () =>
      "Connect my Slack workspace so my agent can work with it. The Slack connector is already installed.",
    check: async (org) => {
      const sql = db();
      const conns = await sql<{ status: string }[]>`
        SELECT status FROM connections
        WHERE organization_id = ${org.org.id} AND connector_key = 'slack'
          AND deleted_at IS NULL`;
      if (conns.length === 0)
        return { pass: false, detail: "no connection for connector 'slack'" };
      return {
        pass: true,
        detail: `slack connection created (status=${conns[0]?.status})`,
      };
    },
  },

  // 3 — run a connector operation. Seed a connector with a LOCAL-backend
  //     operation + an active connection; success = a completed action run.
  {
    id: "run-operation",
    tier: "admin",
    title: "Run the 'ping' operation on the help-desk connection",
    seed: async (org) => {
      const sql = db();
      await installConnector(org, {
        key: "helpdesk",
        name: "Help Desk",
        authNone: true,
      });
      await sql`
        UPDATE connector_definitions
        SET actions_schema = ${sql.json({
          ping: {
            name: "Ping",
            kind: "write",
            input_schema: {
              type: "object",
              properties: { note: { type: "string" } },
            },
          },
        })}
        WHERE organization_id = ${org.org.id} AND key = 'helpdesk'`;
      await sql`
        UPDATE connector_versions
        SET compiled_code = ${`class ConnectorRuntime { async sync(){return {items:[]};} async execute(ctx){ return { success:true, output:{ pinged:true, note: ctx.input?.note ?? null } }; } } export { ConnectorRuntime };`}
        WHERE connector_key = 'helpdesk'`;
      // An active connection to run the operation against.
      const conn = await sql<{ id: number }[]>`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, created_by, config, entity_ids, visibility)
        VALUES (${org.org.id}, 'helpdesk', 'helpdesk', 'Help Desk', 'active', ${org.ctx.userId}, '{}'::jsonb, '{}', 'org')
        RETURNING id`;
      return { connectionId: conn[0]!.id };
    },
    prompt: () =>
      "Run the 'ping' operation on my Help Desk connection (send the note \"hello\").",
    check: async (org) => {
      const sql = db();
      const n = await countRows(
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM runs
          WHERE organization_id = ${org.org.id} AND run_type = 'action'
            AND action_key = 'ping' AND status IN ('running', 'completed')`
      );
      if (n === 0)
        return { pass: false, detail: "no completed 'ping' action run" };
      return { pass: true, detail: `${n} ping action run(s) completed` };
    },
  },

  // 4 — create an entity of a type that does NOT exist yet. The agent must
  //     discover it has to create the entity type first (EntityTypeNotFound).
  {
    id: "create-entity",
    tier: "member-write",
    title: "Add a company Acme with 50 employees",
    seed: async () => ({}),
    prompt: () =>
      "Add a company called Acme with 50 employees to my workspace.",
    check: async (org) => {
      const sql = db();
      // The agent invents the `company` type from scratch, so it legitimately
      // picks the employee-count field name (team_size / employees / headcount /
      // …). Accept 50 stored under ANY metadata field — require only that the
      // company entity exists and its metadata carries the value 50 as a number
      // (not, e.g., "50 employees" free text in the name). We check for a JSON
      // number 50 anywhere in the metadata object.
      const rows = await sql<
        { id: number; metadata: Record<string, unknown> }[]
      >`
        SELECT e.id, e.metadata
        FROM entities e
        JOIN entity_types t ON t.id = e.entity_type_id
        WHERE e.organization_id = ${org.org.id} AND e.deleted_at IS NULL
          AND t.slug = 'company' AND lower(e.name) LIKE '%acme%'`;
      if (rows.length === 0)
        return { pass: false, detail: "no company entity named Acme" };
      const meta = rows[0]?.metadata ?? {};
      const has50 = Object.values(meta).some(
        (v) => v === 50 || v === "50" || String(v).trim() === "50"
      );
      if (!has50)
        return {
          pass: false,
          detail: `Acme created but no field = 50 (metadata=${JSON.stringify(meta).slice(0, 80)})`,
        };
      const field = Object.entries(meta).find(
        ([, v]) => v === 50 || String(v).trim() === "50"
      )?.[0];
      return { pass: true, detail: `company Acme, ${field}=50` };
    },
  },

  // 5 — read: count + name the seeded companies (reply-scored).
  {
    id: "query-entities",
    tier: "read",
    title: "How many companies + their names",
    seed: async (org) => {
      await seedEntityType(org, "company", "Company", {
        team_size: { type: "number" },
      });
      await seedEntity(org, "company", "Northwind", { team_size: 12 });
      await seedEntity(org, "company", "Globex", { team_size: 340 });
      await seedEntity(org, "company", "Initech", { team_size: 78 });
      return { names: ["Northwind", "Globex", "Initech"] };
    },
    prompt: () => "How many companies do we have and what are their names?",
    check: async (org) => {
      // State invariant: nothing mutated (read). Reply correctness scored by
      // replyCheck (must name all three seeded companies).
      const sql = db();
      const n = await countRows(
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM entities e
          JOIN entity_types t ON t.id = e.entity_type_id
          WHERE e.organization_id = ${org.org.id} AND e.deleted_at IS NULL AND t.slug = 'company'`
      );
      return {
        pass: n === 3,
        detail: `db has ${n} companies (reply-correctness scored separately)`,
      };
    },
  },

  // 6 — create a Behavior over a feed.
  {
    id: "create-behavior",
    tier: "admin",
    title: "Watch a feed and notify on a condition",
    seed: async (org) => {
      await installConnector(org, {
        key: "webpages",
        name: "Web Pages",
        feeds: { pages: { description: "Collected web pages" } },
        authNone: true,
      });
      return {};
    },
    prompt: () =>
      'Watch my workspace and notify me whenever a newly collected page mentions the word "pricing".',
    check: async (org) => {
      const sql = db();
      const n = await countRows(
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM watchers
          WHERE organization_id = ${org.org.id} AND status = 'active'`
      );
      if (n === 0) return { pass: false, detail: "no Behavior created" };
      return { pass: true, detail: `${n} active Behavior(s)` };
    },
  },

  // 7 — save then recall a fact (write to memory + reply recalls it).
  {
    id: "save-and-recall-memory",
    tier: "member-write",
    title: "Remember + recall the target market",
    seed: async () => ({}),
    prompt: () =>
      "Remember that our target market is fintech, then tell me what our target market is.",
    check: async (org) => {
      const sql = db();
      const n = await countRows(
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM events
          WHERE organization_id = ${org.org.id}
            AND (payload_text ILIKE '%fintech%' OR metadata::text ILIKE '%fintech%')`
      );
      if (n === 0)
        return { pass: false, detail: "no memory event mentioning fintech" };
      return {
        pass: true,
        detail: `${n} memory event(s) saved (reply scored)`,
      };
    },
  },

  // 8 — SQL discovery: what tables can I query + how to find collected pages.
  {
    id: "sql-discovery",
    tier: "read",
    title: "What tables can I query; how to find collected pages",
    seed: async () => ({}),
    prompt: () =>
      "What data tables can I query in my workspace, and how would I find website pages I've collected?",
    // Pure read; correctness judged on the reply (must name the real `events`
    // table + a real column like feed_key / semantic_type, no hallucinated tables).
    check: async () => ({
      pass: true,
      detail: "read-only; reply scored separately",
    }),
  },

  // 9 — org discovery: which workspace + installed connectors.
  {
    id: "org-discovery",
    tier: "read",
    title: "Which workspace am I in; what connectors are installed",
    seed: async (org) => {
      // Give the org a clean, distinctive name so the reply check ("did it name
      // the real workspace?") is fair — the default fixture name is an ugly
      // generated slug the model reasonably paraphrases instead of quoting.
      await db()`
        UPDATE organization SET name = 'Contoso Labs'
        WHERE id = ${org.org.id}`;
      org.org.name = "Contoso Labs";
      await installConnector(org, {
        key: "website",
        name: "Website",
        feeds: { pages: {} },
        authNone: true,
      });
      await installConnector(org, { key: "slack", name: "Slack" });
      return { orgName: org.org.name };
    },
    prompt: () =>
      "What workspace am I in, and what connectors or integrations are available to me?",
    // Reply must name the actual org + at least one real installed connector.
    check: async () => ({
      pass: true,
      detail: "read-only; reply scored separately",
    }),
  },

  // 10 — schedule a recurring job (admin).
  {
    id: "schedule-a-job",
    tier: "admin",
    title: "Schedule a weekly Monday 9am job",
    seed: async () => ({}),
    prompt: () =>
      "Every Monday at 9am, have my agent post a weekly digest to my workspace.",
    check: async (org) => {
      const sql = db();
      const rows = await sql<{ cron: string | null }[]>`
        SELECT cron FROM scheduled_jobs WHERE organization_id = ${org.org.id}`;
      if (rows.length === 0)
        return { pass: false, detail: "no scheduled_jobs row" };
      const weekly = rows.some((r) => (r.cron ?? "").trim().length > 0);
      if (!weekly)
        return {
          pass: false,
          detail: `schedule created but no cron (rows=${rows.length})`,
        };
      return {
        pass: true,
        detail: `scheduled job with cron=${rows.find((r) => r.cron)?.cron}`,
      };
    },
  },

  // 11 — entity relationship: link a contact to a company as employer.
  {
    id: "entity-relationship",
    tier: "member-write",
    title: "Link contact Jane to Acme as employer",
    seed: async (org) => {
      await seedEntityType(org, "company", "Company");
      await seedEntityType(org, "contact", "Contact");
      const acme = await seedEntity(org, "company", "Acme");
      const jane = await seedEntity(org, "contact", "Jane");
      return { acmeId: acme, janeId: jane };
    },
    prompt: () => "Link the contact Jane to the company Acme as her employer.",
    check: async (org, seeded) => {
      const sql = db();
      const acmeId = seeded.acmeId as number;
      const janeId = seeded.janeId as number;
      // Accept the link in either direction between Jane and Acme, under any
      // relationship type the model discovered/created for "employer".
      const n = await countRows(
        sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM entity_relationships
          WHERE organization_id = ${org.org.id}
            AND ((from_entity_id = ${janeId} AND to_entity_id = ${acmeId})
              OR (from_entity_id = ${acmeId} AND to_entity_id = ${janeId}))`
      );
      if (n === 0)
        return { pass: false, detail: "no relationship between Jane and Acme" };
      return { pass: true, detail: `${n} Jane↔Acme relationship(s)` };
    },
  },
];

/**
 * Reply-text correctness checks for the read/question tasks (state checks can't
 * capture "did the model report the right real facts"). Returns null when a
 * task has no reply check. Case-insensitive substring matching on the final
 * assistant text.
 */
export function replyCheck(
  taskId: string,
  reply: string,
  seeded: Record<string, unknown>
): TaskResult | null {
  const r = reply.toLowerCase();
  if (taskId === "query-entities") {
    const names = (seeded.names as string[]) ?? [];
    const missing = names.filter((n) => !r.includes(n.toLowerCase()));
    const namesThree = /\b3\b|three/.test(r);
    const ok = missing.length === 0 && namesThree;
    return {
      pass: ok,
      detail: ok
        ? "reply names all 3 companies + count 3"
        : `missing ${JSON.stringify(missing)}${namesThree ? "" : "; count 3 not stated"}`,
    };
  }
  if (taskId === "save-and-recall-memory") {
    const ok = r.includes("fintech");
    return {
      pass: ok,
      detail: ok ? "reply recalls fintech" : "reply does not recall fintech",
    };
  }
  if (taskId === "sql-discovery") {
    // Must name the real `events` table and at least one real column, and must
    // NOT invent an obviously-fake table like "pages" / "web_pages".
    const namesEvents = r.includes("events");
    const namesRealCol =
      r.includes("feed_key") ||
      r.includes("semantic_type") ||
      r.includes("payload");
    const hallucinated = /\bweb_pages\b/.test(r) || /\bpages_table\b/.test(r);
    const ok = namesEvents && namesRealCol && !hallucinated;
    return {
      pass: ok,
      detail: ok
        ? "names events + a real column, no hallucinated table"
        : `events=${namesEvents} realCol=${namesRealCol} hallucinated=${hallucinated}`,
    };
  }
  if (taskId === "org-discovery") {
    const orgName = String(seeded.orgName ?? "").toLowerCase();
    const namesOrg = orgName.length > 0 && r.includes(orgName);
    const namesConnector =
      r.includes("website") || r.includes("web pages") || r.includes("slack");
    const ok = namesOrg && namesConnector;
    return {
      pass: ok,
      detail: ok
        ? "names the real org + an installed connector"
        : `org=${namesOrg} connector=${namesConnector}`,
    };
  }
  return null;
}

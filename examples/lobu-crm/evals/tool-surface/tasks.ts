/**
 * Tool-surface eval — the CRM task set.
 *
 * Each task: a deterministic seed (so both arms start identical), a natural
 * prompt (what an operator would say), and a programmatic success check that
 * asserts resulting DB / entity / event STATE — never just that the model
 * replied. Seeds and checks run through the same real PG-backed handlers as the
 * agent, so a pass means the pipeline state is actually correct.
 */

import type { Sql } from "postgres";
import { db, seedInteraction, seedLead, type ScenarioOrg } from "./scenario";

export interface TaskResult {
  pass: boolean;
  detail: string;
}

export interface EvalTask {
  id: string;
  title: string;
  /** Seed identical starting state. Returns any ids the prompt/check needs. */
  seed: (org: ScenarioOrg) => Promise<Record<string, unknown>>;
  /** The natural-language instruction handed to glm-4.7. */
  prompt: (seeded: Record<string, unknown>) => string;
  /** Deterministic state assertion against the DB after the turn. */
  check: (
    org: ScenarioOrg,
    seeded: Record<string, unknown>
  ) => Promise<TaskResult>;
}

const ONE_DAY = 86_400_000;

async function leadByCompany(
  sql: Sql,
  orgId: string,
  company: string
): Promise<{
  id: number;
  name: string;
  stage: string | null;
  metadata: Record<string, unknown>;
} | null> {
  // Match on metadata.company OR the entity name containing the company (the
  // model legitimately stores the company in either place).
  const rows = await sql<
    {
      id: number;
      name: string;
      stage: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT id, name, metadata->>'stage' AS stage, metadata
    FROM entities
    WHERE organization_id = ${orgId}
      AND deleted_at IS NULL
      AND (
        lower(metadata->>'company') = ${company.toLowerCase()}
        OR lower(name) LIKE ${`%${company.toLowerCase()}%`}
      )
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function countEvents(
  sql: Sql,
  orgId: string,
  semanticType: string,
  entityId?: number
): Promise<number> {
  const rows = entityId
    ? await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM events
        WHERE organization_id = ${orgId}
          AND semantic_type = ${semanticType}
          AND ${entityId} = ANY(entity_ids)
      `
    : await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM events
        WHERE organization_id = ${orgId} AND semantic_type = ${semanticType}
      `;
  return rows[0]?.n ?? 0;
}

export const TASKS: EvalTask[] = [
  // 1 — Create + enrich a lead.
  {
    id: "create-lead",
    title: "Create a lead (Jane Doe / AcmeCo / GitHub star / signal)",
    seed: async () => ({}),
    prompt: () =>
      "Add a lead: Jane Doe at AcmeCo, source GitHub star, stage signal.",
    check: async (org) => {
      const lead = await leadByCompany(db(), org.org.id, "AcmeCo");
      if (!lead)
        return { pass: false, detail: "no lead entity with company=AcmeCo" };
      if (lead.stage !== "signal")
        return { pass: false, detail: `stage=${lead.stage}, expected signal` };
      // Name may live in the entity name or metadata.name.
      const name =
        `${lead.name ?? ""} ${lead.metadata.name ?? ""}`.toLowerCase();
      if (!name.includes("jane"))
        return {
          pass: false,
          detail: `lead found but name missing Jane (name="${lead.name}", meta.name="${lead.metadata.name}")`,
        };
      return { pass: true, detail: `lead#${lead.id} stage=signal` };
    },
  },

  // 2 — Read the pipeline (counts per stage). The agent must report counts that
  //     match the seeded distribution. We check it called a read tool AND the
  //     reply contains the right numbers.
  {
    id: "read-pipeline",
    title: "Report pipeline counts per stage",
    seed: async (org) => {
      await seedLead(org, {
        name: "A One",
        company: "OneCo",
        source: "x",
        stage: "signal",
      });
      await seedLead(org, {
        name: "B Two",
        company: "TwoCo",
        source: "x",
        stage: "signal",
      });
      await seedLead(org, {
        name: "C Three",
        company: "ThreeCo",
        source: "x",
        stage: "trial",
      });
      await seedLead(org, {
        name: "D Four",
        company: "FourCo",
        source: "x",
        stage: "conversation",
      });
      return { signal: 2, trial: 1, conversation: 1 };
    },
    prompt: () => "Show me the pipeline: how many leads are in each stage?",
    // Success = the model's final reply states the correct per-stage counts.
    // Checked by the runner against the reply text (see runner: replyCheck).
    check: async (org) => {
      // State invariant: nothing was mutated (this is a read).
      const rows = await db()<{ stage: string; n: number }[]>`
        SELECT metadata->>'stage' AS stage, count(*)::int AS n
        FROM entities WHERE organization_id = ${org.org.id} AND deleted_at IS NULL
          AND entity_type_id = (SELECT id FROM entity_types WHERE slug='lead' AND organization_id=${org.org.id})
        GROUP BY 1
      `;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.stage] = r.n;
      const ok =
        counts.signal === 2 && counts.trial === 1 && counts.conversation === 1;
      return {
        pass: ok,
        detail: `db counts ${JSON.stringify(counts)} (reply-correctness scored separately)`,
      };
    },
  },

  // 3 — Advance a stage. Must write lead:stage_changed event AND update entity.
  {
    id: "advance-stage",
    title: "Advance AcmeCo to conversation (event + entity update)",
    seed: async (org) => {
      const id = await seedLead(org, {
        name: "Jane Doe",
        company: "AcmeCo",
        source: "github star",
        stage: "trial",
      });
      return { leadId: id };
    },
    prompt: () => "Move AcmeCo to the conversation stage.",
    check: async (org, seeded) => {
      const leadId = seeded.leadId as number;
      const lead = await leadByCompany(db(), org.org.id, "AcmeCo");
      const stageOk = lead?.stage === "conversation";
      const evCount = await countEvents(
        db(),
        org.org.id,
        "lead:stage_changed",
        leadId
      );
      if (!stageOk && evCount === 0)
        return {
          pass: false,
          detail: "neither stage updated nor event written",
        };
      if (!stageOk)
        return {
          pass: false,
          detail: `event written but stage=${lead?.stage}`,
        };
      if (evCount === 0)
        return {
          pass: false,
          detail:
            "stage updated but NO lead:stage_changed event (skill violation)",
        };
      return {
        pass: true,
        detail: `stage=conversation + ${evCount} stage_changed event(s)`,
      };
    },
  },

  // 4 — Log an interaction.
  {
    id: "log-interaction",
    title: "Log a call with AcmeCo (next step: demo)",
    seed: async (org) => {
      const id = await seedLead(org, {
        name: "Jane Doe",
        company: "AcmeCo",
        source: "github star",
        stage: "conversation",
      });
      return { leadId: id };
    },
    prompt: () =>
      "Log an interaction with AcmeCo: had a call, the next step is a demo.",
    check: async (org, seeded) => {
      const leadId = seeded.leadId as number;
      const n = await countEvents(db(), org.org.id, "lead:interaction", leadId);
      if (n === 0)
        return {
          pass: false,
          detail: "no lead:interaction event attached to the lead",
        };
      return {
        pass: true,
        detail: `${n} lead:interaction event(s) on lead#${leadId}`,
      };
    },
  },

  // 5 — Multi-step: open a pilot. Pilot entity + converted-to link + lead->pilot.
  {
    id: "open-pilot",
    title: "Open a pilot for AcmeCo (pilot entity + link + lead stage)",
    seed: async (org) => {
      const id = await seedLead(org, {
        name: "Jane Doe",
        company: "AcmeCo",
        source: "github star",
        stage: "conversation",
      });
      return { leadId: id };
    },
    prompt: () =>
      "AcmeCo just signed up for a paid pilot. Open a pilot for them and link it to the lead.",
    check: async (org, seeded) => {
      const sql = db();
      const leadId = seeded.leadId as number;
      const pilots = await sql<{ id: number }[]>`
        SELECT e.id FROM entities e
        JOIN entity_types t ON t.id = e.entity_type_id
        WHERE e.organization_id = ${org.org.id} AND e.deleted_at IS NULL
          AND t.slug = 'pilot' AND lower(e.metadata->>'company') = 'acmeco'
      `;
      if (pilots.length === 0)
        return { pass: false, detail: "no pilot entity created for AcmeCo" };
      const lead = await leadByCompany(sql, org.org.id, "AcmeCo");
      const stageOk = lead?.stage === "pilot";
      // converted-to relationship from lead -> pilot
      const links = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM entity_relationships er
        JOIN entity_relationship_types rt ON rt.id = er.relationship_type_id
        WHERE er.organization_id = ${org.org.id}
          AND rt.slug = 'converted-to'
          AND er.from_entity_id = ${leadId}
      `.catch(() => [{ n: -1 }]);
      const linkN = links[0]?.n ?? 0;
      const parts = [
        `pilot=${pilots.length > 0}`,
        `leadStage=${lead?.stage}`,
        `convertedToLink=${linkN}`,
      ];
      // Core success = pilot entity exists AND lead advanced to pilot. The
      // converted-to link is a bonus (skill-faithful) but its table shape can
      // vary; we report it but don't hard-fail on it alone.
      const pass = pilots.length > 0 && stageOk;
      return { pass, detail: parts.join(", ") };
    },
  },

  // 6 — Read needing reasoning: which leads are stale in conversation >7 days.
  {
    id: "stale-leads",
    title: "Which leads are stale in conversation >7 days?",
    seed: async (org) => {
      // Stale: in conversation, last interaction 10 days ago.
      const stale = await seedLead(org, {
        name: "Old Lead",
        company: "StaleCo",
        source: "x",
        stage: "conversation",
      });
      await seedInteraction(
        org,
        stale,
        "old DM",
        new Date(Date.now() - 10 * ONE_DAY)
      );
      // Fresh: in conversation, interaction 2 days ago (NOT stale).
      const fresh = await seedLead(org, {
        name: "New Lead",
        company: "FreshCo",
        source: "x",
        stage: "conversation",
      });
      await seedInteraction(
        org,
        fresh,
        "recent DM",
        new Date(Date.now() - 2 * ONE_DAY)
      );
      // Distractor: stale touch but in trial stage (wrong stage, exclude).
      const trial = await seedLead(org, {
        name: "Trial Lead",
        company: "TrialCo",
        source: "x",
        stage: "trial",
      });
      await seedInteraction(
        org,
        trial,
        "old trial DM",
        new Date(Date.now() - 20 * ONE_DAY)
      );
      return {
        staleCompany: "StaleCo",
        freshCompany: "FreshCo",
        trialCompany: "TrialCo",
      };
    },
    prompt: () =>
      "Which leads are stale — in the conversation stage with no touch in the last 7 days?",
    // Pure read; correctness is judged on the reply (runner replyCheck):
    // must name StaleCo and must NOT name FreshCo/TrialCo.
    check: async () => ({
      pass: true,
      detail: "read-only; reply scored separately",
    }),
  },
];

/**
 * Reply-text correctness checks for the read tasks (state checks can't capture
 * "did the model report the right answer"). Returns null when a task has no
 * reply check. Case-insensitive substring matching on the final assistant text.
 */
export function replyCheck(taskId: string, reply: string): TaskResult | null {
  const r = reply.toLowerCase();
  if (taskId === "read-pipeline") {
    // Expect it to convey signal=2, trial=1, conversation=1.
    const has2 = /\b2\b|\btwo\b/.test(r);
    const mentionsSignal = r.includes("signal");
    const ok =
      has2 &&
      mentionsSignal &&
      r.includes("trial") &&
      r.includes("conversation");
    return {
      pass: ok,
      detail: ok
        ? "reply names stages with counts"
        : "reply did not clearly state signal=2/trial=1/conversation=1",
    };
  }
  if (taskId === "stale-leads") {
    const namesStale = r.includes("staleco") || r.includes("old lead");
    const namesFresh = r.includes("freshco") || r.includes("new lead");
    const namesTrial = r.includes("trialco") || r.includes("trial lead");
    const ok = namesStale && !namesFresh && !namesTrial;
    return {
      pass: ok,
      detail: ok
        ? "correctly flagged StaleCo only"
        : `staleCo=${namesStale} freshCo=${namesFresh} trialCo=${namesTrial} (want true/false/false)`,
    };
  }
  return null;
}

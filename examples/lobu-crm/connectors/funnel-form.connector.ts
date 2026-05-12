/**
 * Funnel-form connector — pulls demo-request form submissions from a small
 * JSON API (`config.endpoint` returns `{ submissions: [...] }`) and emits one
 * event per new submission. Modeled on packages/connectors/src/rss.ts.
 *
 * No auth (`authSchema: { methods: [{ type: 'none' }] }`); a single
 * `submissions` feed; dedup via a checkpoint of seen submission IDs.
 *
 * Auto-discovered by `lobu apply` because the filename ends in
 * `.connector.ts` — the CLI ships the raw source to the server, which
 * compiles it and reads `definition.key` (`funnel-form`).
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface FunnelFormConfig {
  endpoint: string;
}

interface FunnelFormCheckpoint {
  seen_ids: string[];
}

interface FunnelSubmission {
  id: string;
  name?: string;
  email?: string;
  company?: string;
  message?: string;
  submitted_at?: string;
  source_url?: string;
}

const MAX_DEDUP_IDS = 1000;
const FETCH_TIMEOUT_MS = 15_000;

export default class FunnelFormConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "funnel-form",
    name: "Funnel form",
    description:
      "Collects demo-request form submissions from a JSON API endpoint.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      submissions: {
        key: "submissions",
        name: "Form submissions",
        description: "New submissions to the demo-request form.",
        configSchema: {
          type: "object",
          required: ["endpoint"],
          properties: {
            endpoint: {
              type: "string",
              format: "uri",
              description:
                "JSON API URL returning { submissions: [{ id, name, email, company, message, submitted_at }] }.",
            },
          },
        },
        eventKinds: {
          form_submission: {
            description: "A demo-request form submission.",
            metadataSchema: {
              type: "object",
              properties: {
                company: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: "object",
      required: ["endpoint"],
      properties: {
        endpoint: {
          type: "string",
          format: "uri",
          description: "JSON API URL returning { submissions: [...] }.",
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as FunnelFormConfig;
    if (!config?.endpoint) {
      throw new Error("funnel-form: `endpoint` is required");
    }

    const checkpoint = (ctx.checkpoint as FunnelFormCheckpoint | null) ?? {
      seen_ids: [],
    };
    const seen = new Set<string>(checkpoint.seen_ids ?? []);

    const submissions = await this.fetchSubmissions(config.endpoint);
    submissions.sort(
      (a, b) =>
        this.toTime(b.submitted_at).getTime() -
        this.toTime(a.submitted_at).getTime()
    );

    const events: EventEnvelope[] = [];
    const newIds: string[] = [];
    for (const submission of submissions) {
      if (!submission?.id || seen.has(submission.id)) continue;
      seen.add(submission.id);
      newIds.push(submission.id);
      events.push({
        origin_id: submission.id,
        origin_type: "form_submission",
        title: submission.company
          ? `Demo request — ${submission.company}`
          : `Demo request — ${submission.name ?? submission.email ?? submission.id}`,
        payload_text: submission.message ?? "",
        author_name: submission.name || undefined,
        source_url: submission.source_url || config.endpoint,
        occurred_at: this.toTime(submission.submitted_at),
        metadata: {
          company: submission.company,
          email: submission.email,
        },
      });
    }

    const allKnown = [...(checkpoint.seen_ids ?? []), ...newIds];
    const trimmed = allKnown.slice(-MAX_DEDUP_IDS);

    return {
      events,
      checkpoint: { seen_ids: trimmed } as unknown as Record<string, unknown>,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchSubmissions(
    endpoint: string
  ): Promise<FunnelSubmission[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const body = (await response.json()) as {
        submissions?: FunnelSubmission[];
      };
      return Array.isArray(body?.submissions) ? body.submissions : [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toTime(value: string | undefined): Date {
    if (!value) return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}

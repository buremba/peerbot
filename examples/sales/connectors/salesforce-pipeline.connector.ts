/**
 * Salesforce-pipeline connector — polls Salesforce REST for opportunities
 * updated since the last checkpoint and emits one event per opportunity
 * change. Used by the `sales` agent to keep its Opportunity entities in sync
 * with the source of truth.
 *
 * Auth: OAuth (Salesforce Connected App). Workers never see the token; the
 * gateway secret-proxy swaps the placeholder at egress.
 *
 * Auto-discovered by `lobu apply` because the filename ends in
 * `.connector.ts`.
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

interface PipelineConfig {
  instance_url: string;
  stages?: string[];
}

interface PipelineCheckpoint {
  last_modified: string;
}

interface SfOpportunity {
  Id: string;
  Name: string;
  StageName: string;
  Amount?: number;
  CloseDate?: string;
  AccountId?: string;
  LastModifiedDate: string;
}

const PAGE_SIZE = 200;

export default class SalesforcePipelineConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "salesforce-pipeline",
    name: "Salesforce pipeline",
    description: "Polls Salesforce REST for opportunity changes.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "salesforce" }] },
    feeds: {
      opportunities: {
        key: "opportunities",
        name: "Opportunity changes",
        description:
          "Opportunities created or updated since the last sync cursor.",
        configSchema: {
          type: "object",
          required: ["instance_url"],
          properties: {
            instance_url: { type: "string", format: "uri" },
            stages: { type: "array", items: { type: "string" } },
          },
        },
        eventKinds: {
          opportunity_updated: {
            description: "An opportunity was created or modified.",
            metadataSchema: {
              type: "object",
              properties: {
                stage: { type: "string" },
                amount: { type: "number" },
                account_id: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as PipelineConfig;
    if (!config?.instance_url) {
      throw new Error("salesforce-pipeline: `instance_url` is required");
    }

    const checkpoint = (ctx.checkpoint as PipelineCheckpoint | null) ?? {
      last_modified: "2000-01-01T00:00:00Z",
    };
    const soql = this.buildSoql(checkpoint.last_modified, config.stages);
    const url = `${config.instance_url.replace(/\/$/, "")}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;

    const opportunities = await this.fetchOpportunities(url);
    const events: EventEnvelope[] = opportunities.map((opp) => ({
      origin_id: opp.Id,
      origin_type: "opportunity_updated",
      title: `Opportunity ${opp.Name} → ${opp.StageName}`,
      payload_text: `Amount: ${opp.Amount ?? "?"} · Closes ${opp.CloseDate ?? "?"}`,
      source_url: `${config.instance_url}/lightning/r/Opportunity/${opp.Id}/view`,
      occurred_at: new Date(opp.LastModifiedDate),
      metadata: {
        stage: opp.StageName,
        amount: opp.Amount,
        account_id: opp.AccountId,
      },
    }));

    const nextCursor =
      opportunities.length === 0
        ? checkpoint.last_modified
        : opportunities[opportunities.length - 1].LastModifiedDate;

    return {
      events,
      checkpoint: { last_modified: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private buildSoql(since: string, stages?: string[]): string {
    const stageFilter =
      stages && stages.length > 0
        ? ` AND StageName IN (${stages.map((s) => `'${s}'`).join(",")})`
        : "";
    return `SELECT Id, Name, StageName, Amount, CloseDate, AccountId, LastModifiedDate FROM Opportunity WHERE LastModifiedDate > ${since}${stageFilter} ORDER BY LastModifiedDate ASC LIMIT ${PAGE_SIZE}`;
  }

  private async fetchOpportunities(url: string): Promise<SfOpportunity[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Salesforce ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as { records?: SfOpportunity[] };
    return body.records ?? [];
  }
}

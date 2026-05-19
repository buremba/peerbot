import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Opp = { Id: string; Name: string; StageName: string; Amount?: number; LastModifiedDate: string };

export default class SalesforcePipelineConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "salesforce-pipeline",
    name: "Salesforce pipeline",
    description: "Polls Salesforce REST for opportunity changes.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "salesforce" }] },
    feeds: { opportunities: { key: "opportunities", name: "Opportunities" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const since =
      (ctx.checkpoint as { last_modified?: string } | null)?.last_modified ??
      "2000-01-01T00:00:00Z";
    const q = `SELECT Id,Name,StageName,Amount,LastModifiedDate FROM Opportunity WHERE LastModifiedDate > ${since} ORDER BY LastModifiedDate ASC LIMIT 200`;
    const r = await fetch(`${ctx.config.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(q)}`);
    const { records = [] } = (await r.json()) as { records?: Opp[] };
    return {
      events: records.map((o) => ({
        origin_id: o.Id,
        origin_type: "opportunity_updated",
        title: `${o.Name} → ${o.StageName}`,
        occurred_at: new Date(o.LastModifiedDate),
        metadata: { stage: o.StageName, amount: o.Amount },
      })),
      checkpoint: { last_modified: records.at(-1)?.LastModifiedDate ?? since } as unknown as Record<string, unknown>,
    };
  }
}

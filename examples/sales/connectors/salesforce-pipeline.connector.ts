import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class SalesforcePipelineConnector extends ConnectorRuntime {
  readonly definition = {
    key: "salesforce-pipeline",
    name: "Salesforce pipeline",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "salesforce" }] },
    feeds: { opportunities: { key: "opportunities", name: "Opportunities" } },
  };

  async sync(ctx: SyncContext) {
    const since = (ctx.checkpoint as { last_modified?: string } | null)?.last_modified ?? "2000-01-01T00:00:00Z";
    const q = `SELECT Id,Name,StageName,LastModifiedDate FROM Opportunity WHERE LastModifiedDate > ${since} LIMIT 200`;
    const r = await fetch(`${ctx.config.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(q)}`);
    const { records = [] } = (await r.json()) as { records?: Array<{ Id: string; Name: string; StageName: string; LastModifiedDate: string }> };
    return {
      events: records.map((o) => ({
        origin_id: o.Id,
        origin_type: "opportunity_updated",
        title: `${o.Name} → ${o.StageName}`,
        occurred_at: new Date(o.LastModifiedDate),
      })),
      checkpoint: { last_modified: records.at(-1)?.LastModifiedDate ?? since } as Record<string, unknown>,
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}

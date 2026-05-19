// biome-ignore-all format: stays compact for the landing-page code panel
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
    const since = (ctx.checkpoint as any)?.last_modified ?? "2000-01-01T00:00:00Z";
    const q = `SELECT Id,Name,StageName,LastModifiedDate FROM Opportunity WHERE LastModifiedDate > ${since} LIMIT 200`;
    const r = await fetch(`${ctx.config.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(q)}`);
    const records: any[] = (await r.json() as any).records ?? [];
    return {
      events: records.map((o) => ({
        origin_id: o.Id,
        origin_type: "opportunity_updated",
        title: `${o.Name} → ${o.StageName}`,
        occurred_at: new Date(o.LastModifiedDate),
      })),
      checkpoint: { last_modified: records.at(-1)?.LastModifiedDate ?? since },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}

// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class DocuSignEnvelopesConnector extends ConnectorRuntime {
  readonly definition = {
    key: "docusign-envelopes",
    name: "DocuSign envelopes",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth" as const, provider: "docusign" }] },
    feeds: { envelopes: { key: "envelopes", name: "Envelope status changes" } },
  };

  async sync(ctx: SyncContext) {
    const since = (ctx.checkpoint as any)?.last_status_changed ?? "2000-01-01T00:00:00Z";
    const base = String(ctx.config.base_path ?? "https://www.docusign.net/restapi").replace(/\/$/, "");
    const r = await fetch(`${base}/v2.1/accounts/${ctx.config.account_id}/envelopes?from_date=${encodeURIComponent(since)}&count=100`);
    const envelopes: any[] = ((await r.json() as any).envelopes ?? []).sort((a: any, b: any) => new Date(a.statusChangedDateTime).getTime() - new Date(b.statusChangedDateTime).getTime());
    return {
      events: envelopes.map((e) => ({
        origin_id: `${e.envelopeId}:${e.status}`,
        origin_type: "envelope_status_changed",
        title: `${e.emailSubject ?? e.envelopeId} → ${e.status}`,
        occurred_at: new Date(e.statusChangedDateTime),
      })),
      checkpoint: { last_status_changed: envelopes.at(-1)?.statusChangedDateTime ?? since },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}

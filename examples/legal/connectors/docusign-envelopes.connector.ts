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
    const since = (ctx.checkpoint as { last_status_changed?: string } | null)?.last_status_changed ?? "2000-01-01T00:00:00Z";
    const base = (ctx.config.base_path ?? "https://www.docusign.net/restapi").toString().replace(/\/$/, "");
    const r = await fetch(`${base}/v2.1/accounts/${ctx.config.account_id}/envelopes?from_date=${encodeURIComponent(since)}&count=100`);
    const { envelopes = [] } = (await r.json()) as { envelopes?: Array<{ envelopeId: string; status: string; emailSubject?: string; statusChangedDateTime: string }> };
    envelopes.sort((a, b) => new Date(a.statusChangedDateTime).getTime() - new Date(b.statusChangedDateTime).getTime());
    return {
      events: envelopes.map((e) => ({
        origin_id: `${e.envelopeId}:${e.status}`,
        origin_type: "envelope_status_changed",
        title: `${e.emailSubject ?? e.envelopeId} → ${e.status}`,
        occurred_at: new Date(e.statusChangedDateTime),
      })),
      checkpoint: { last_status_changed: envelopes.at(-1)?.statusChangedDateTime ?? since } as Record<string, unknown>,
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}

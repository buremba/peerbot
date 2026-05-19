import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Envelope = { envelopeId: string; status: string; emailSubject?: string; statusChangedDateTime: string; sender?: { userName?: string; email?: string } };

export default class DocuSignEnvelopesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "docusign-envelopes",
    name: "DocuSign envelopes",
    description: "Polls DocuSign for envelope status transitions.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "docusign" }] },
    feeds: { envelopes: { key: "envelopes", name: "Envelope status changes" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const since =
      (ctx.checkpoint as { last_status_changed?: string } | null)?.last_status_changed ??
      "2000-01-01T00:00:00Z";
    const base = (ctx.config.base_path ?? "https://www.docusign.net/restapi").replace(/\/$/, "");
    const url = `${base}/v2.1/accounts/${ctx.config.account_id}/envelopes?from_date=${encodeURIComponent(since)}&count=100`;
    const { envelopes = [] } = (await (await fetch(url)).json()) as { envelopes?: Envelope[] };
    envelopes.sort((a, b) => new Date(a.statusChangedDateTime).getTime() - new Date(b.statusChangedDateTime).getTime());
    return {
      events: envelopes.map((e) => ({
        origin_id: `${e.envelopeId}:${e.status}`,
        origin_type: "envelope_status_changed",
        title: `${e.emailSubject ?? e.envelopeId} → ${e.status}`,
        author_name: e.sender?.userName,
        occurred_at: new Date(e.statusChangedDateTime),
        metadata: { status: e.status, sender_email: e.sender?.email },
      })),
      checkpoint: { last_status_changed: envelopes.at(-1)?.statusChangedDateTime ?? since } as unknown as Record<string, unknown>,
    };
  }
}

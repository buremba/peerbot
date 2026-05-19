/**
 * DocuSign-envelopes connector — polls the DocuSign eSignature API for
 * envelopes that changed status since the last sync, emitting one event per
 * envelope transition. The `legal` agent uses these to keep its Contract
 * entities in sync and to trigger downstream clause-review watchers.
 *
 * Auth: OAuth (DocuSign JWT/PKCE). The access token is held by the gateway
 * secret-proxy; this connector only references the `lobu_secret_<uuid>`
 * placeholder via the default fetch path.
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

interface DocuSignConfig {
  account_id: string;
  base_path?: string;
}

interface DocuSignCheckpoint {
  last_status_changed: string;
}

interface DsEnvelope {
  envelopeId: string;
  status: string;
  emailSubject?: string;
  statusChangedDateTime: string;
  sender?: { userName?: string; email?: string };
}

const PAGE_SIZE = 100;

export default class DocuSignEnvelopesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "docusign-envelopes",
    name: "DocuSign envelopes",
    description:
      "Polls DocuSign for envelope status transitions (sent → signed → completed).",
    version: "1.0.0",
    authSchema: { methods: [{ type: "oauth", provider: "docusign" }] },
    feeds: {
      envelopes: {
        key: "envelopes",
        name: "Envelope status changes",
        description: "Envelopes whose status changed since the last cursor.",
        configSchema: {
          type: "object",
          required: ["account_id"],
          properties: {
            account_id: { type: "string" },
            base_path: {
              type: "string",
              format: "uri",
              description:
                "DocuSign REST base path (e.g. https://demo.docusign.net/restapi).",
            },
          },
        },
        eventKinds: {
          envelope_status_changed: {
            description: "An envelope transitioned to a new status.",
            metadataSchema: {
              type: "object",
              properties: {
                status: { type: "string" },
                sender_email: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as DocuSignConfig;
    if (!config?.account_id) {
      throw new Error("docusign-envelopes: `account_id` is required");
    }

    const checkpoint = (ctx.checkpoint as DocuSignCheckpoint | null) ?? {
      last_status_changed: "2000-01-01T00:00:00Z",
    };
    const basePath = (
      config.base_path ?? "https://www.docusign.net/restapi"
    ).replace(/\/$/, "");
    const url = `${basePath}/v2.1/accounts/${config.account_id}/envelopes?from_date=${encodeURIComponent(checkpoint.last_status_changed)}&count=${PAGE_SIZE}`;

    const envelopes = await this.fetchEnvelopes(url);
    envelopes.sort(
      (a, b) =>
        new Date(a.statusChangedDateTime).getTime() -
        new Date(b.statusChangedDateTime).getTime()
    );

    const events: EventEnvelope[] = envelopes.map((env) => ({
      origin_id: `${env.envelopeId}:${env.status}`,
      origin_type: "envelope_status_changed",
      title: env.emailSubject
        ? `${env.emailSubject} → ${env.status}`
        : `Envelope ${env.envelopeId} → ${env.status}`,
      author_name: env.sender?.userName,
      source_url: `${basePath}/v2.1/accounts/${config.account_id}/envelopes/${env.envelopeId}`,
      occurred_at: new Date(env.statusChangedDateTime),
      metadata: {
        status: env.status,
        sender_email: env.sender?.email,
      },
    }));

    const nextCursor =
      envelopes.length === 0
        ? checkpoint.last_status_changed
        : envelopes[envelopes.length - 1].statusChangedDateTime;

    return {
      events,
      checkpoint: { last_status_changed: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchEnvelopes(url: string): Promise<DsEnvelope[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`DocuSign ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as { envelopes?: DsEnvelope[] };
    return body.envelopes ?? [];
  }
}

/**
 * Stripe-charges connector — pulls newly-succeeded Stripe charges and
 * refunds and emits one event per charge so the `ecommerce` agent can
 * populate Order entities, drive its refund-pattern dreaming watcher, and
 * close the loop with Shopify/inventory data.
 *
 * Auth: Stripe restricted key with `charges:read` + `refunds:read` scopes.
 * Keys live in the gateway secret-proxy; the worker only ever sees the
 * `lobu_secret_<uuid>` placeholder.
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

interface StripeConfig {
  livemode?: boolean;
}

interface StripeCheckpoint {
  last_created: number;
}

interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  description?: string | null;
  status: string;
  paid: boolean;
  refunded: boolean;
  created: number;
  receipt_email?: string;
  customer?: string;
}

const PAGE_SIZE = 100;
const ENDPOINT = "https://api.stripe.com/v1/charges";

export default class StripeChargesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "stripe-charges",
    name: "Stripe charges",
    description:
      "Streams new charge / refund events from the Stripe API into Lobu memory.",
    version: "1.0.0",
    authSchema: {
      methods: [
        {
          type: "env",
          fields: [
            { name: "secret_key", description: "Stripe restricted secret key" },
          ],
        },
      ],
    },
    feeds: {
      charges: {
        key: "charges",
        name: "Charges",
        description:
          "Succeeded charges + refunds, ordered by created timestamp.",
        configSchema: {
          type: "object",
          properties: {
            livemode: { type: "boolean", default: true },
          },
        },
        eventKinds: {
          charge_succeeded: {
            description: "A charge was successfully captured.",
            metadataSchema: {
              type: "object",
              properties: {
                amount: { type: "integer" },
                currency: { type: "string" },
                customer: { type: "string" },
              },
            },
          },
          charge_refunded: {
            description: "A charge was refunded in full or part.",
            metadataSchema: {
              type: "object",
              properties: {
                amount: { type: "integer" },
                currency: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const checkpoint = (ctx.checkpoint as StripeCheckpoint | null) ?? {
      last_created: 0,
    };
    const url = `${ENDPOINT}?limit=${PAGE_SIZE}&created[gt]=${checkpoint.last_created}`;

    const charges = await this.fetchCharges(url);
    charges.sort((a, b) => a.created - b.created);

    const events: EventEnvelope[] = charges.map((charge) => ({
      origin_id: charge.refunded ? `${charge.id}:refund` : charge.id,
      origin_type: charge.refunded ? "charge_refunded" : "charge_succeeded",
      title: `${charge.refunded ? "Refund" : "Charge"} — ${(charge.amount / 100).toFixed(2)} ${charge.currency.toUpperCase()}`,
      payload_text: charge.description ?? "",
      author_name: charge.receipt_email,
      source_url: `https://dashboard.stripe.com/payments/${charge.id}`,
      occurred_at: new Date(charge.created * 1000),
      metadata: {
        amount: charge.amount,
        currency: charge.currency,
        customer: charge.customer,
      },
    }));

    const nextCursor =
      charges.length === 0
        ? checkpoint.last_created
        : charges[charges.length - 1].created;

    return {
      events,
      checkpoint: { last_created: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchCharges(url: string): Promise<StripeCharge[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Stripe ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as { data?: StripeCharge[] };
    return body.data ?? [];
  }
}

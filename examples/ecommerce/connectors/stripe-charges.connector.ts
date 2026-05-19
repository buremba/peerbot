import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Charge = { id: string; amount: number; currency: string; description?: string | null; refunded: boolean; created: number; receipt_email?: string; customer?: string };

export default class StripeChargesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "stripe-charges",
    name: "Stripe charges",
    description: "Streams Stripe charge / refund events into Lobu memory.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env", fields: [{ name: "secret_key" }] }] },
    feeds: { charges: { key: "charges", name: "Charges" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const cursor =
      (ctx.checkpoint as { last_created?: number } | null)?.last_created ?? 0;
    const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gt]=${cursor}`);
    const { data = [] } = (await r.json()) as { data?: Charge[] };
    data.sort((a, b) => a.created - b.created);
    return {
      events: data.map((c) => ({
        origin_id: c.refunded ? `${c.id}:refund` : c.id,
        origin_type: c.refunded ? "charge_refunded" : "charge_succeeded",
        title: `${c.refunded ? "Refund" : "Charge"} — ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
        payload_text: c.description ?? "",
        author_name: c.receipt_email,
        source_url: `https://dashboard.stripe.com/payments/${c.id}`,
        occurred_at: new Date(c.created * 1000),
        metadata: { amount: c.amount, currency: c.currency, customer: c.customer },
      })),
      checkpoint: { last_created: data.at(-1)?.created ?? cursor } as unknown as Record<string, unknown>,
    };
  }
}

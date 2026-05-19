// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class StripeChargesConnector extends ConnectorRuntime {
  readonly definition = {
    key: "stripe-charges",
    name: "Stripe charges",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env" as const, fields: [{ name: "secret_key" }] }] },
    feeds: { charges: { key: "charges", name: "Charges" } },
  };

  async sync(ctx: SyncContext) {
    const cursor = (ctx.checkpoint as any)?.last_created ?? 0;
    const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gt]=${cursor}`);
    const data: any[] = ((await r.json() as any).data ?? []).sort((a: any, b: any) => a.created - b.created);
    return {
      events: data.map((c) => ({
        origin_id: c.refunded ? `${c.id}:refund` : c.id,
        origin_type: c.refunded ? "charge_refunded" : "charge_succeeded",
        title: `${c.refunded ? "Refund" : "Charge"} — ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
        source_url: `https://dashboard.stripe.com/payments/${c.id}`,
        occurred_at: new Date(c.created * 1000),
      })),
      checkpoint: { last_created: data.at(-1)?.created ?? cursor },
    };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}

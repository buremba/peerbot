import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

type Order = { id: number; name: string; financial_status?: string; fulfillment_status?: string; total_price?: string; updated_at: string };

export default class ShopifyOrdersConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "shopify-orders",
    name: "Shopify orders",
    description: "Polls Shopify Admin REST for new and updated orders.",
    version: "1.0.0",
    authSchema: { methods: [{ type: "env", fields: [{ name: "access_token" }] }] },
    feeds: { orders: { key: "orders", name: "Order updates" } },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const since =
      (ctx.checkpoint as { updated_at_min?: string } | null)?.updated_at_min ??
      "2000-01-01T00:00:00Z";
    const url = `https://${ctx.config.shop}/admin/api/2024-10/orders.json?status=any&updated_at_min=${encodeURIComponent(since)}&limit=100`;
    const { orders = [] } = (await (await fetch(url)).json()) as { orders?: Order[] };
    orders.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    return {
      events: orders.map((o) => ({
        origin_id: `${o.id}:${o.updated_at}`,
        origin_type: "order_updated",
        title: `Order ${o.name} — ${o.fulfillment_status ?? "unfulfilled"}`,
        source_url: `https://${ctx.config.shop}/admin/orders/${o.id}`,
        occurred_at: new Date(o.updated_at),
        metadata: { financial_status: o.financial_status, total_price: o.total_price },
      })),
      checkpoint: { updated_at_min: orders.at(-1)?.updated_at ?? since } as unknown as Record<string, unknown>,
    };
  }
}

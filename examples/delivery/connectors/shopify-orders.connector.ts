/**
 * Shopify-orders connector — polls a Shopify shop's REST Admin API for new
 * or updated orders and emits one event per order transition (created,
 * paid, fulfilled, refunded). The `delivery` agent uses these to drive its
 * fulfilment-status entities and the at-risk-shipment dreaming watcher.
 *
 * Auth: Shopify private-app access token (header `X-Shopify-Access-Token`).
 * Workers never see the real token; the gateway secret-proxy swaps the
 * placeholder at egress.
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

interface ShopifyConfig {
  shop: string;
  status?: "open" | "closed" | "cancelled" | "any";
}

interface ShopifyCheckpoint {
  updated_at_min: string;
}

interface ShopifyOrder {
  id: number;
  name: string;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string;
  total_price?: string;
  updated_at: string;
  created_at: string;
  customer?: { first_name?: string; last_name?: string };
}

const PAGE_SIZE = 100;
const API_VERSION = "2024-10";

export default class ShopifyOrdersConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "shopify-orders",
    name: "Shopify orders",
    description:
      "Polls Shopify Admin REST for new and updated orders to drive fulfilment workflows.",
    version: "1.0.0",
    authSchema: {
      methods: [
        {
          type: "env",
          fields: [
            { name: "access_token", description: "Shopify Admin API token" },
          ],
        },
      ],
    },
    feeds: {
      orders: {
        key: "orders",
        name: "Order updates",
        description: "Orders updated since the last cursor.",
        configSchema: {
          type: "object",
          required: ["shop"],
          properties: {
            shop: {
              type: "string",
              description: "Shopify shop subdomain (e.g. acme.myshopify.com)",
            },
            status: {
              type: "string",
              enum: ["open", "closed", "cancelled", "any"],
              default: "any",
            },
          },
        },
        eventKinds: {
          order_updated: {
            description: "A Shopify order was created or updated.",
            metadataSchema: {
              type: "object",
              properties: {
                financial_status: { type: "string" },
                fulfillment_status: { type: "string" },
                total_price: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as ShopifyConfig;
    if (!config?.shop) {
      throw new Error("shopify-orders: `shop` is required");
    }

    const checkpoint = (ctx.checkpoint as ShopifyCheckpoint | null) ?? {
      updated_at_min: "2000-01-01T00:00:00Z",
    };
    const status = config.status ?? "any";
    const url = `https://${config.shop}/admin/api/${API_VERSION}/orders.json?status=${status}&updated_at_min=${encodeURIComponent(checkpoint.updated_at_min)}&limit=${PAGE_SIZE}`;

    const orders = await this.fetchOrders(url);
    orders.sort(
      (a, b) =>
        new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

    const events: EventEnvelope[] = orders.map((order) => ({
      origin_id: `${order.id}:${order.updated_at}`,
      origin_type: "order_updated",
      title: `Order ${order.name} — ${order.fulfillment_status ?? "unfulfilled"}`,
      payload_text: `Financial: ${order.financial_status ?? "?"} · Total: ${order.total_price ?? "?"}`,
      author_name: order.customer
        ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
        : undefined,
      source_url: `https://${config.shop}/admin/orders/${order.id}`,
      occurred_at: new Date(order.updated_at),
      metadata: {
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        total_price: order.total_price,
      },
    }));

    const nextCursor =
      orders.length === 0
        ? checkpoint.updated_at_min
        : orders[orders.length - 1].updated_at;

    return {
      events,
      checkpoint: { updated_at_min: nextCursor } as unknown as Record<
        string,
        unknown
      >,
      metadata: { items_found: events.length },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  private async fetchOrders(url: string): Promise<ShopifyOrder[]> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Shopify ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as { orders?: ShopifyOrder[] };
    return body.orders ?? [];
  }
}

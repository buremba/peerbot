import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import { describe, expect, it, vi } from "vitest";
import productActivityDigest, {
  buildProductActivityCard,
  collectProductActivityDigest,
} from "../product-activity-digest.reaction.ts";

const context = {
  extracted_data: { run: true },
  entities: [],
  window: {
    id: 99,
    behavior_id: 42,
    window_start: "2026-08-13T12:00:00.000Z",
    window_end: "2026-08-13T12:20:00.000Z",
    granularity: "20 minutes",
    content_analyzed: 0,
  },
  behavior: {
    id: 42,
    slug: "product-activity-digest",
    name: "Lobu production activity digest",
    version: 1,
  },
  organization_id: "lobu-team-id",
  organization_slug: "lobu-team",
} satisfies ReactionContext;

describe("Lobu Team product activity digest reaction", () => {
  it("stays silent when the window has no activity", async () => {
    const send = vi.fn();
    const log = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue([]),
      notifications: { send },
      log,
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "No production activity; Slack digest skipped",
      expect.objectContaining({
        window_start: "2026-08-13T12:00:00.000Z",
        window_end: "2026-08-13T12:20:00.000Z",
      })
    );
  });

  it("sends one rich digest containing users, emails, clients, and log details", async () => {
    const rows = [
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_id: "signup:u1",
          activity_type: "signup",
          user_id: "u1",
          user_name: "Ada Lovelace",
          email: "ada@example.com",
          organization_name: "Analytical Engines",
        },
      },
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_id: "login:s1",
          activity_type: "login",
          user_id: "u1",
          user_name: "Ada Lovelace",
          email: "ada@example.com",
          organization_name: "Analytical Engines",
        },
      },
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_id: "connection:7",
          activity_type: "connection",
          connector_key: "google.gmail",
          connection_name: "Ada's Gmail",
          email: "ada@example.com",
          organization_name: "Analytical Engines",
        },
      },
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_id: "mcp:1",
          activity_type: "mcp_conversation",
          user_id: "u1",
          user_name: "Ada Lovelace",
          email: "ada@example.com",
          organization_name: "Analytical Engines",
          client_software_id: "lobu-cli",
          last_action: "memory.search",
          call_count: 13,
          failed_count: 1,
        },
      },
      {
        connection_slug: "lobu-production-logs",
        source_url: "https://grafana.example.test",
        metadata: {
          errors: 2,
          warnings: 1,
          error_samples: ["[server] pool exhausted"],
          warning_samples: ["[worker] retrying"],
        },
      },
    ];
    const send = vi.fn().mockResolvedValue({ notified_count: 1 });
    const client = {
      query: vi.fn().mockResolvedValue(rows),
      notifications: { send },
      log: vi.fn(),
    } as unknown as ReactionClient;

    await productActivityDigest(context, client);

    expect(send).toHaveBeenCalledTimes(1);
    const notification = send.mock.calls[0]?.[0];
    expect(notification).toMatchObject({
      title: "Lobu production activity digest",
      recipients: "admins",
      idempotency_key: "product-activity-digest:99",
      behavior_source: { behavior_id: 42, window_id: 99 },
    });
    const serializedCard = JSON.stringify(notification?.card);
    expect(serializedCard).toContain("Ada Lovelace");
    expect(serializedCard).toContain("ada@example.com");
    expect(serializedCard).toContain("lobu-cli");
    expect(serializedCard).toContain("memory.search");
    expect(serializedCard).toContain("13 total calls");
    expect(serializedCard).toContain("1 failed");
    expect(serializedCard).toContain("pool exhausted");
    expect(serializedCard).toContain("Open production logs");
  });

  it("deduplicates online users while retaining every activity section", () => {
    const digest = collectProductActivityDigest([
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_type: "login",
          activity_id: "login:1",
          user_id: "u1",
          user_name: "Ada",
          email: "ada@example.com",
        },
      },
      {
        connection_slug: "lobu-product-activity-db",
        payload_data: {
          activity_type: "mcp_conversation",
          activity_id: "mcp:1",
          user_id: "u1",
          user_name: "Ada",
          email: "ada@example.com",
          client_software_id: "codex",
        },
      },
    ]);
    const card = buildProductActivityCard(digest, {
      start: context.window.window_start,
      end: context.window.window_end,
    });

    expect(JSON.stringify(card)).toContain(
      '"label":"Online users","value":"1"'
    );
    expect(JSON.stringify(card)).toContain("Active MCP conversations (1)");
  });
});

import type {
  CardElement,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";

const PRODUCT_ACTIVITY_CONNECTION = "lobu-product-activity-db";
const LOG_ACTIVITY_CONNECTION = "lobu-production-logs";
const CARD_TEXT_LIMIT = 2_800;

export const input = {
  type: "object",
  properties: {
    run: { type: "boolean" },
  },
  required: ["run"],
};

interface ActivityRow {
  connection_slug: string;
  payload_data?: unknown;
  metadata?: unknown;
  source_url?: string | null;
}

interface ProductActivity {
  activity_type?: string;
  activity_id?: string;
  user_id?: string | null;
  user_name?: string | null;
  email?: string | null;
  organization_name?: string | null;
  connector_key?: string | null;
  connection_name?: string | null;
  client_software_id?: string | null;
  last_action?: string | null;
  call_count?: number | string | null;
  failed_count?: number | string | null;
}

interface LogActivity {
  errors?: number;
  warnings?: number;
  error_samples?: string[];
  warning_samples?: string[];
}

export interface ProductActivityDigest {
  signups: ProductActivity[];
  logins: ProductActivity[];
  connections: ProductActivity[];
  mcp_conversations: ProductActivity[];
  errors: number;
  warnings: number;
  error_samples: string[];
  warning_samples: string[];
  logs_url: string | null;
}

export function collectProductActivityDigest(
  rows: ActivityRow[]
): ProductActivityDigest {
  const digest: ProductActivityDigest = {
    signups: [],
    logins: [],
    connections: [],
    mcp_conversations: [],
    errors: 0,
    warnings: 0,
    error_samples: [],
    warning_samples: [],
    logs_url: null,
  };

  for (const row of rows) {
    if (row.connection_slug === PRODUCT_ACTIVITY_CONNECTION) {
      const activity = record(row.payload_data) as unknown as ProductActivity;
      if (activity.activity_type === "signup") digest.signups.push(activity);
      if (activity.activity_type === "login") digest.logins.push(activity);
      if (activity.activity_type === "connection") {
        digest.connections.push(activity);
      }
      if (activity.activity_type === "mcp_conversation") {
        digest.mcp_conversations.push(activity);
      }
      continue;
    }

    if (row.connection_slug === LOG_ACTIVITY_CONNECTION) {
      const activity = record(row.metadata) as unknown as LogActivity;
      digest.errors += finiteCount(activity.errors);
      digest.warnings += finiteCount(activity.warnings);
      digest.error_samples.push(...stringArray(activity.error_samples));
      digest.warning_samples.push(...stringArray(activity.warning_samples));
      if (row.source_url) digest.logs_url = row.source_url;
    }
  }

  digest.error_samples = [...new Set(digest.error_samples)];
  digest.warning_samples = [...new Set(digest.warning_samples)];
  return digest;
}

export function hasProductActivity(digest: ProductActivityDigest): boolean {
  return (
    digest.signups.length > 0 ||
    digest.logins.length > 0 ||
    digest.connections.length > 0 ||
    digest.mcp_conversations.length > 0 ||
    digest.errors > 0 ||
    digest.warnings > 0
  );
}

export function buildProductActivityCard(
  digest: ProductActivityDigest,
  window: { start: string; end: string }
): CardElement {
  const online = uniqueUsers([...digest.logins, ...digest.mcp_conversations]);
  const children: CardElement[] = [
    {
      type: "fields",
      children: [
        field("Signups", digest.signups.length),
        field("Login sessions", digest.logins.length),
        field("Online users", online.length),
        field("New connections", digest.connections.length),
        field("Active MCP conversations", digest.mcp_conversations.length),
        field("Errors / warnings", `${digest.errors} / ${digest.warnings}`),
      ],
    },
  ];

  appendSection(children, "New signups", digest.signups.map(formatUser));
  appendSection(children, "Online users", online.map(formatUser));
  appendSection(
    children,
    "New connections",
    digest.connections.map(
      (item) =>
        `${safe(item.connector_key ?? "unknown connector")} — ` +
        `${safe(item.connection_name ?? "Unnamed connection")} — ` +
        `${safe(item.organization_name ?? "Unknown organization")}` +
        (item.email ? ` — created by ${safe(item.email)}` : "")
    )
  );
  appendSection(
    children,
    "Active MCP conversations",
    digest.mcp_conversations.map(
      (item) =>
        `${safe(item.client_software_id ?? "Unknown client")} — ` +
        `${formatUser(item)}` +
        (item.last_action ? ` — ${safe(item.last_action)}` : "") +
        (finiteCount(item.call_count) > 0
          ? ` — ${finiteCount(item.call_count)} total calls`
          : "") +
        (finiteCount(item.failed_count) > 0
          ? ` — ${finiteCount(item.failed_count)} failed`
          : "")
    )
  );
  appendSection(children, "Recent errors", digest.error_samples);
  appendSection(children, "Recent warnings", digest.warning_samples);
  if (digest.logs_url) {
    children.push({
      type: "actions",
      children: [
        {
          type: "link-button",
          url: digest.logs_url,
          label: "Open production logs",
        },
      ],
    });
  }

  return {
    type: "card",
    title: "Lobu production activity",
    subtitle: formatWindow(window.start, window.end),
    children,
  };
}

function field(label: string, value: string | number): CardElement {
  return { type: "field", label, value: String(value) };
}

function appendSection(
  children: CardElement[],
  heading: string,
  values: string[]
): void {
  if (values.length === 0) return;
  children.push({ type: "divider" });
  for (const content of chunkText(
    `**${heading} (${values.length})**\n${values.map((value) => `• ${value}`).join("\n")}`
  )) {
    children.push({ type: "text", content });
  }
}

function chunkText(value: string): string[] {
  const lines = value.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= CARD_TEXT_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line.slice(0, CARD_TEXT_LIMIT);
  }
  if (current) chunks.push(current);
  return chunks;
}

function uniqueUsers(rows: ProductActivity[]): ProductActivity[] {
  const users = new Map<string, ProductActivity>();
  for (const row of rows) {
    const key =
      row.user_id ?? row.email ?? `anonymous:${row.activity_id ?? ""}`;
    const existing = users.get(key);
    if (!existing || (!existing.email && row.email)) users.set(key, row);
  }
  return [...users.values()];
}

function formatUser(user: ProductActivity): string {
  const name = safe(user.user_name?.trim() || "Unnamed user");
  const email = user.email ? safe(user.email) : "anonymous";
  const organization = user.organization_name
    ? ` — ${safe(user.organization_name)}`
    : "";
  return `${name} — ${email}${organization}`;
}

function formatWindow(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (
    !Number.isFinite(startDate.getTime()) ||
    !Number.isFinite(endDate.getTime())
  ) {
    return `${start} → ${end}`;
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return `${formatter.format(startDate)} → ${formatter.format(endDate)} UTC`;
}

function summaryBody(
  digest: ProductActivityDigest,
  window: { start: string; end: string }
): string {
  return (
    `${formatWindow(window.start, window.end)} · ` +
    `${digest.signups.length} signups · ` +
    `${digest.logins.length} login sessions · ` +
    `${uniqueUsers([...digest.logins, ...digest.mcp_conversations]).length} online users · ` +
    `${digest.connections.length} new connections · ` +
    `${digest.mcp_conversations.length} active MCP conversations · ` +
    `${digest.errors} errors · ${digest.warnings} warnings`
  );
}

function safe(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function finiteCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const start = new Date(ctx.window.window_start);
  const end = new Date(ctx.window.window_end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Product activity digest received an invalid window");
  }

  const rows = (await client.query(`
    SELECT
      c.slug AS connection_slug,
      e.payload_data,
      e.metadata,
      e.source_url
    FROM events e
    JOIN connections c ON c.id = e.connection_id
    WHERE c.slug IN ('${PRODUCT_ACTIVITY_CONNECTION}', '${LOG_ACTIVITY_CONNECTION}')
      AND e.superseded_by IS NULL
      AND e.created_at > '${start.toISOString()}'::timestamptz
      AND e.created_at <= '${end.toISOString()}'::timestamptz
    ORDER BY e.created_at ASC, e.id ASC
    LIMIT 5000
  `)) as ActivityRow[];
  const digest = collectProductActivityDigest(rows);
  if (!hasProductActivity(digest)) {
    client.log("No production activity; Slack digest skipped", {
      window_start: start.toISOString(),
      window_end: end.toISOString(),
    });
    return;
  }

  await client.notifications.send({
    title: "Lobu production activity digest",
    body: summaryBody(digest, {
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    card: buildProductActivityCard(digest, {
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    recipients: "admins",
    idempotency_key: `product-activity-digest:${ctx.window.id}`,
    behavior_source: {
      behavior_id: ctx.window.behavior_id,
      window_id: ctx.window.id,
    },
  });
};

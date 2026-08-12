import type { Env } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../db/client";

export const PRODUCT_OPS_DIGEST_TASK = "product-ops-digest";
const DEFAULT_WINDOW_MS = 20 * 60 * 1000;
const LOG_INGESTION_LAG_MS = 2 * 60 * 1000;
const ACTIVE_ALERT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DETAIL_LIMIT = 10;

export interface ProductOpsDigestConfig {
  lokiUrl: string;
  alertmanagerUrl: string;
  namespace: string;
  grafanaUrl?: string;
}

export interface ProductOpsDigestWindow {
  start: Date;
  end: Date;
}

interface UserActivity {
  userId: string;
  name: string | null;
  email: string;
}

interface ConnectionActivity {
  connectorKey: string;
  displayName: string | null;
  organizationName: string;
}

interface McpConversationActivity {
  userId: string | null;
  clientSoftwareId: string | null;
  organizationName: string;
}

export interface ProductOpsActivity {
  signups: UserActivity[];
  logins: UserActivity[];
  connections: ConnectionActivity[];
  mcpConversations: McpConversationActivity[];
}

export interface ProductOpsDigestStore {
  resolveWindow(taskRunId: number): Promise<ProductOpsDigestWindow>;
  collectActivity(window: ProductOpsDigestWindow): Promise<ProductOpsActivity>;
}

interface ProductOpsLogCounts {
  errors: number;
  warnings: number;
}

interface RunProductOpsDigestParams {
  taskRunId: number;
  config: ProductOpsDigestConfig;
  store?: ProductOpsDigestStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ProductOpsDigestResult {
  posted: boolean;
  window: ProductOpsDigestWindow;
  activity: ProductOpsActivity;
  logs: ProductOpsLogCounts;
}

export function productOpsDigestConfigFromEnv(
  env: Env,
): ProductOpsDigestConfig | null {
  if (env.LOBU_PRODUCT_OPS_DIGEST_ENABLED !== "1") return null;

  const lokiUrl = env.LOBU_PRODUCT_OPS_LOKI_URL?.trim();
  const alertmanagerUrl = env.LOBU_PRODUCT_OPS_ALERTMANAGER_URL?.trim();
  const namespace = env.LOBU_PRODUCT_OPS_NAMESPACE?.trim();
  if (!lokiUrl || !alertmanagerUrl || !namespace) {
    throw new Error(
      "LOBU_PRODUCT_OPS_DIGEST_ENABLED requires LOBU_PRODUCT_OPS_LOKI_URL, " +
        "LOBU_PRODUCT_OPS_ALERTMANAGER_URL, and LOBU_PRODUCT_OPS_NAMESPACE",
    );
  }

  const grafanaUrl = env.LOBU_PRODUCT_OPS_GRAFANA_URL?.trim();
  return {
    lokiUrl: trimTrailingSlash(lokiUrl),
    alertmanagerUrl: trimTrailingSlash(alertmanagerUrl),
    namespace,
    ...(grafanaUrl ? { grafanaUrl } : {}),
  };
}

export function createProductOpsDigestStore(
  sql: DbClient = getDb(),
): ProductOpsDigestStore {
  return {
    async resolveWindow(taskRunId) {
      const currentRows = await sql<{ scheduled_tick: string | Date | null }>`
        SELECT action_input->>'__scheduledTick' AS scheduled_tick
        FROM public.runs
        WHERE id = ${taskRunId}
          AND run_type = 'task'
          AND action_key = ${PRODUCT_OPS_DIGEST_TASK}
        LIMIT 1
      `;
      const scheduledTick = parseTick(currentRows[0]?.scheduled_tick);
      if (!scheduledTick) {
        throw new Error(
          `Product operations task ${taskRunId} has no scheduled tick`,
        );
      }
      const end = collectionBoundary(scheduledTick);

      const previousRows = await sql<{ scheduled_tick: string | Date | null }>`
        SELECT action_input->>'__scheduledTick' AS scheduled_tick
        FROM public.runs
        WHERE id < ${taskRunId}
          AND run_type = 'task'
          AND action_key = ${PRODUCT_OPS_DIGEST_TASK}
          AND status = 'completed'
          AND action_input->>'__scheduledTick' IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `;
      const previousTick = parseTick(previousRows[0]?.scheduled_tick);
      const start = previousTick
        ? collectionBoundary(previousTick)
        : new Date(end.getTime() - DEFAULT_WINDOW_MS);
      if (start.getTime() >= end.getTime()) {
        throw new Error(
          `Product operations cursor ${start.toISOString()} is not before ${end.toISOString()}`,
        );
      }
      return { start, end };
    },

    async collectActivity(window) {
      const [signups, logins, connections, mcpConversations] =
        await Promise.all([
          sql<UserActivity>`
          SELECT id AS "userId", name, email
          FROM public."user"
          WHERE "createdAt" > ${window.start}
            AND "createdAt" <= ${window.end}
            AND COALESCE(principal_kind, 'human') = 'human'
          ORDER BY "createdAt" ASC, id ASC
        `,
          sql<UserActivity>`
          SELECT u.id AS "userId", u.name, u.email
          FROM public.session s
          JOIN public."user" u ON u.id = s."userId"
          WHERE s."createdAt" > ${window.start}
            AND s."createdAt" <= ${window.end}
            AND COALESCE(u.principal_kind, 'human') = 'human'
          ORDER BY s."createdAt" ASC, s.id ASC
        `,
          sql<ConnectionActivity>`
          SELECT
            c.connector_key AS "connectorKey",
            c.display_name AS "displayName",
            o.name AS "organizationName"
          FROM public.connections c
          JOIN public.organization o ON o.id = c.organization_id
          WHERE c.created_at > ${window.start}
            AND c.created_at <= ${window.end}
          ORDER BY c.created_at ASC, c.id ASC
        `,
          sql<McpConversationActivity>`
          SELECT
            m.user_id AS "userId",
            m.client_software_id AS "clientSoftwareId",
            o.name AS "organizationName"
          FROM public.mcp_client_conversations m
          JOIN public.organization o ON o.id = m.organization_id
          WHERE m.first_activity_at > ${window.start}
            AND m.first_activity_at <= ${window.end}
            AND m.call_count > 0
          ORDER BY m.first_activity_at ASC, m.organization_id ASC,
            m.client_identity ASC, m.conversation_id ASC
        `,
        ]);
      return { signups, logins, connections, mcpConversations };
    },
  };
}

export async function runProductOpsDigest({
  taskRunId,
  config,
  store = createProductOpsDigestStore(),
  fetchImpl = fetch,
  now = () => new Date(),
}: RunProductOpsDigestParams): Promise<ProductOpsDigestResult> {
  const window = await store.resolveWindow(taskRunId);
  const activity: ProductOpsActivity = {
    signups: [],
    logins: [],
    connections: [],
    mcpConversations: [],
  };
  const logs = { errors: 0, warnings: 0 };
  let posted = false;

  // A later tick may be claimed by another replica while an older tick is
  // retrying. Catch up one exact interval at a time: the interval end is the
  // Alertmanager fingerprint, so concurrent/retried sends dedupe without a
  // second lock while every missed interval remains recoverable.
  for (const interval of splitDigestWindows(window)) {
    const [intervalActivity, intervalLogs] = await Promise.all([
      store.collectActivity(interval),
      queryLokiLogCounts(config, interval, fetchImpl),
    ]);
    activity.signups.push(...intervalActivity.signups);
    activity.logins.push(...intervalActivity.logins);
    activity.connections.push(...intervalActivity.connections);
    activity.mcpConversations.push(...intervalActivity.mcpConversations);
    logs.errors += intervalLogs.errors;
    logs.warnings += intervalLogs.warnings;

    if (!hasDigestActivity(intervalActivity, intervalLogs)) continue;
    await deliverDigestAlert(
      config,
      interval,
      intervalActivity,
      intervalLogs,
      fetchImpl,
      now(),
    );
    posted = true;
  }

  return { posted, window, activity, logs };
}

async function deliverDigestAlert(
  config: ProductOpsDigestConfig,
  window: ProductOpsDigestWindow,
  activity: ProductOpsActivity,
  logs: ProductOpsLogCounts,
  fetchImpl: typeof fetch,
  deliveryTime: Date,
): Promise<void> {
  const description = formatDigestDescription(config, window, activity, logs);
  const alert = {
    labels: {
      alertname: "LobuProductOpsDigest",
      severity: "info",
      namespace: config.namespace,
      digest_window_end: window.end.toISOString().replace(/[.:]/g, "_"),
    },
    annotations: {
      summary: "Lobu production activity digest",
      description,
    },
    startsAt: deliveryTime.toISOString(),
    endsAt: new Date(deliveryTime.getTime() + ACTIVE_ALERT_MS).toISOString(),
    ...(config.grafanaUrl ? { generatorURL: config.grafanaUrl } : {}),
  };
  const response = await fetchImpl(`${config.alertmanagerUrl}/api/v2/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([alert]),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Alertmanager delivery failed with ${response.status}`);
  }
}

function splitDigestWindows(
  window: ProductOpsDigestWindow,
): ProductOpsDigestWindow[] {
  const duration = window.end.getTime() - window.start.getTime();
  if (duration <= 0 || duration % DEFAULT_WINDOW_MS !== 0) {
    throw new Error(
      `Product operations range must contain whole 20-minute windows: ` +
        `${window.start.toISOString()} to ${window.end.toISOString()}`,
    );
  }
  const windows: ProductOpsDigestWindow[] = [];
  for (
    let start = window.start.getTime();
    start < window.end.getTime();
    start += DEFAULT_WINDOW_MS
  ) {
    windows.push({
      start: new Date(start),
      end: new Date(start + DEFAULT_WINDOW_MS),
    });
  }
  return windows;
}

async function queryLokiLogCounts(
  config: ProductOpsDigestConfig,
  window: ProductOpsDigestWindow,
  fetchImpl: typeof fetch,
): Promise<ProductOpsLogCounts> {
  const seconds = Math.max(
    1,
    Math.ceil((window.end.getTime() - window.start.getTime()) / 1000),
  );
  const namespace = escapeLogQlString(config.namespace);
  const query =
    `sum by (level) (count_over_time({namespace="${namespace}"} ` +
    `| json | __error__="" ` +
    `| level=~"(?i)(warn|warning|error|fatal|panic)" [${seconds}s]))`;
  const url = new URL(`${config.lokiUrl}/loki/api/v1/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("time", String(window.end.getTime() / 1000));
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Loki query failed with ${response.status}`);
  }

  const body = (await response.json()) as {
    status?: unknown;
    data?: { resultType?: unknown; result?: unknown };
  };
  if (
    body.status !== "success" ||
    body.data?.resultType !== "vector" ||
    !Array.isArray(body.data.result)
  ) {
    throw new Error("Loki query returned an invalid response");
  }

  let errors = 0;
  let warnings = 0;
  for (const item of body.data.result) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as {
      metric?: { level?: unknown };
      value?: unknown[];
    };
    const level = String(candidate.metric?.level ?? "").toLowerCase();
    const count = Number(candidate.value?.[1] ?? 0);
    if (!Number.isFinite(count) || count < 0) {
      throw new Error("Loki query returned an invalid log count");
    }
    if (level === "error" || level === "fatal" || level === "panic") {
      errors += count;
    } else if (level === "warn" || level === "warning") {
      warnings += count;
    }
  }
  return { errors, warnings };
}

function hasDigestActivity(
  activity: ProductOpsActivity,
  logs: ProductOpsLogCounts,
): boolean {
  return (
    activity.signups.length > 0 ||
    activity.logins.length > 0 ||
    activity.connections.length > 0 ||
    activity.mcpConversations.length > 0 ||
    logs.errors > 0 ||
    logs.warnings > 0
  );
}

function formatDigestDescription(
  config: ProductOpsDigestConfig,
  window: ProductOpsDigestWindow,
  activity: ProductOpsActivity,
  logs: ProductOpsLogCounts,
): string {
  const lines = [
    `Window: ${window.start.toISOString()} to ${window.end.toISOString()}`,
  ];
  if (activity.signups.length > 0) {
    lines.push(
      `Signups: ${activity.signups.length} — ${formatDetails(
        activity.signups.map(formatUser),
      )}`,
    );
  }
  if (activity.logins.length > 0) {
    const uniqueUsers = new Map(
      activity.logins.map((user) => [user.userId, user]),
    );
    lines.push(
      `Logins: ${activity.logins.length} ${plural(activity.logins.length, "session")} / ` +
        `${uniqueUsers.size} ${plural(uniqueUsers.size, "user")} — ` +
        formatDetails([...uniqueUsers.values()].map(formatUser)),
    );
  }
  if (activity.connections.length > 0) {
    lines.push(
      `New connections: ${activity.connections.length} — ${formatDetails(
        activity.connections.map(
          (connection) =>
            `${slackSafe(connection.connectorKey)}: ` +
            `${slackSafe(connection.displayName ?? "unnamed")} ` +
            `(${slackSafe(connection.organizationName)})`,
        ),
      )}`,
    );
  }
  if (activity.mcpConversations.length > 0) {
    const users = new Set(
      activity.mcpConversations
        .map((conversation) => conversation.userId)
        .filter((userId): userId is string => Boolean(userId)),
    );
    const clients = new Set(
      activity.mcpConversations.map(
        (conversation) => conversation.clientSoftwareId ?? "unknown client",
      ),
    );
    const clientDetails = activity.mcpConversations.map(
      (conversation) =>
        `${slackSafe(conversation.clientSoftwareId ?? "unknown client")} ` +
        `(${slackSafe(conversation.organizationName)})`,
    );
    lines.push(
      `MCP activity: ${activity.mcpConversations.length} new ` +
        `${plural(activity.mcpConversations.length, "conversation")} / ` +
        `${users.size} authenticated ${plural(users.size, "user")} / ` +
        `${clients.size} ${plural(clients.size, "client")} — ` +
        formatDetails(clientDetails),
    );
  }
  if (logs.errors > 0 || logs.warnings > 0) {
    lines.push(
      `Kubernetes logs: ${logs.errors} ${plural(logs.errors, "error")} / ` +
        `${logs.warnings} ${plural(logs.warnings, "warning")}`,
    );
  }
  if (config.grafanaUrl) lines.push(`Logs: ${config.grafanaUrl}`);
  return lines.join("\n");
}

function formatUser(user: UserActivity): string {
  const name = slackSafe(user.name?.trim() || "Unnamed user");
  return `${name} (${slackSafe(user.email)})`;
}

function formatDetails(values: string[]): string {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, DETAIL_LIMIT);
  const remainder = unique.length - shown.length;
  return remainder > 0
    ? `${shown.join(", ")} (+${remainder} more)`
    : shown.join(", ");
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function slackSafe(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseTick(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collectionBoundary(scheduledTick: Date): Date {
  return new Date(scheduledTick.getTime() - LOG_INGESTION_LAG_MS);
}

function escapeLogQlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

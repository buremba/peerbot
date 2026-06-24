/**
 * Reaction for the `lunch-finalize` watcher.
 *
 * The agent's turn collects orders and picks a restaurant; this reaction then
 * does the Deliveroo work the agent itself can't (executing connector actions
 * needs the watcher's system context):
 *
 *   1. search_restaurants(restaurant) on the office's Deliveroo connection →
 *      the matching restaurant's live URL.
 *   2. read_menu(url) → the live menu (names + prices, straight off the office's
 *      signed-in Chrome via the paired Owletto extension).
 *   3. Post the confirmed live menu + the Deliveroo order link back to the
 *      channel so a human can place + pay.
 *
 * Both actions drive the paired Owletto Chrome extension. If no extension is
 * online (or the connection isn't set up) the reaction logs and returns — the
 * agent's own summary already handed the order off, so this is additive.
 *
 * Budget note: reaction scripts run under a ~60s wall-clock cap, and each
 * `operations.execute` blocks until the extension claims + completes the scrape.
 * So this is best-effort — it expects the office extension to be online and
 * responsive (search is a light list scrape; read_menu is capped to a few
 * scrolls to stay quick). If the budget is exceeded the reaction is aborted
 * (the operation's poll is cancelled, see waitForDeviceActionRun's abortSignal)
 * and the agent's summary still stands.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

/**
 * The reaction owns its input contract: it declares the shape it consumes as a
 * plain JSON Schema (no TypeBox — importing it into a reaction bundle breaks the
 * isolate's SDK client proxy). The host validates `ctx.extracted_data` against
 * this schema before the reaction runs, failing the run loudly on a mismatch
 * rather than acting on malformed data, so the handler just reads it with a cast.
 */
export const input = {
  type: "object",
  properties: {
    outcome: { enum: ["placed", "manual", "cancelled", "no-run"] },
    restaurant: { type: "string" },
  },
  required: ["outcome"],
};

interface Input {
  outcome: "placed" | "manual" | "cancelled" | "no-run";
  restaurant?: string;
}

interface SearchOutput {
  restaurants?: Array<{ name: string; url: string }>;
}

interface MenuOutput {
  restaurant_url?: string;
  items?: Array<{ name: string; price?: string }>;
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  // The host has already validated the payload against this reaction's own
  // contract (`input`); read it with a cast.
  const data = ctx.extracted_data as Input;
  const restaurant = (data.restaurant ?? "").trim();
  // Only chase a menu when the run actually settled on a restaurant.
  if (!restaurant || (data.outcome !== "placed" && data.outcome !== "manual")) {
    return;
  }

  // Find the office's Deliveroo connection. `client.query` is already scoped to
  // this reaction's org, so no org predicate is needed (and string-interpolating
  // one in would be a poor pattern to copy).
  const connRows = (await client.query(
    `SELECT id FROM connections
     WHERE connector_key = 'deliveroo'
       AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1`
  )) as Array<{ id: number }>;
  if (connRows.length === 0) {
    client.log("No Deliveroo connection configured — skipping live menu.");
    return;
  }
  const connectionId = Number(connRows[0].id);
  const watcherSource = {
    watcher_id: ctx.window.watcher_id,
    window_id: ctx.window.id,
  };

  // (1) Search for the restaurant the run chose.
  const search = await client.operations.execute({
    connection_id: connectionId,
    operation_key: "search_restaurants",
    input: { query: restaurant },
    watcher_source: watcherSource,
  });
  if (search.status !== "completed") {
    client.log(
      `Deliveroo search failed: ${search.error_message ?? search.status}`
    );
    return;
  }
  const found = (search.output as SearchOutput | undefined)?.restaurants ?? [];
  // search_restaurants falls back to the full nearby list when nothing matches
  // the query by name, so confirm the top hit actually matches before reading
  // its menu — otherwise we'd post a menu for a restaurant nobody asked for.
  const needle = restaurant.toLowerCase();
  const pick = found.find((r) => r.name.toLowerCase().includes(needle));
  if (!pick) {
    client.log(`No Deliveroo restaurant matched "${restaurant}".`);
    return;
  }

  // (2) Read its live menu. Cap the scroll so the scrape stays inside the
  // reaction budget (the full menu isn't needed for a shortlist).
  const menu = await client.operations.execute({
    connection_id: connectionId,
    operation_key: "read_menu",
    input: { restaurant_url: pick.url, max_scrolls: 6 },
    watcher_source: watcherSource,
  });
  if (menu.status !== "completed") {
    client.log(
      `Deliveroo read_menu failed: ${menu.error_message ?? menu.status}`
    );
    return;
  }
  const items = (menu.output as MenuOutput | undefined)?.items ?? [];
  if (items.length === 0) {
    client.log(`Read ${pick.name} but found no menu items.`);
    return;
  }

  // (3) Post the confirmed live menu + order link to the channel.
  const shortlist = items
    .slice(0, 12)
    .map((it, i) => `${i + 1}. ${it.name}${it.price ? ` — ${it.price}` : ""}`)
    .join("\n");
  const body = [
    `Live ${pick.name} menu (via Deliveroo) — someone place + pay:`,
    pick.url,
    "",
    shortlist,
  ].join("\n");

  await client.notifications.send({
    title: `${pick.name} — live menu (${items.length} items)`,
    body,
    watcher_source: watcherSource,
  });

  client.log(
    `Posted live ${pick.name} menu (${items.length} items) from ${pick.url}.`
  );
};

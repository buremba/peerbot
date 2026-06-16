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
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

interface FinalizeData {
  outcome?: "placed" | "manual" | "cancelled" | "no-run";
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
  const data = ctx.extracted_data as FinalizeData;
  const restaurant = (data.restaurant ?? "").trim();
  // Only chase a menu when the run actually settled on a restaurant.
  if (!restaurant || (data.outcome !== "placed" && data.outcome !== "manual")) {
    return;
  }

  // Find the office's Deliveroo connection in this org.
  const connRows = (await client.query(
    `SELECT id FROM connections
     WHERE connector_key = 'deliveroo'
       AND organization_id = '${ctx.organization_id}'
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
  if (found.length === 0) {
    client.log(`No Deliveroo restaurant matched "${restaurant}".`);
    return;
  }
  const pick = found[0];

  // (2) Read its live menu.
  const menu = await client.operations.execute({
    connection_id: connectionId,
    operation_key: "read_menu",
    input: { restaurant_url: pick.url },
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

import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineWatcher,
  reactionFromFile,
  secret,
  skillFromFile,
} from "@lobu/cli/config";
import type DeliverooConnector from "./deliveroo.connector.ts";
import type lunchDeliverooReaction from "./lunch-deliveroo.reaction.ts";

const foodOrdering = defineAgent({
  id: "food-ordering",
  name: "food-ordering",
  description:
    "Runs the office lunch order — presence check, recommendations, options poll, order collection, Deliveroo basket handoff",
  dir: ".",
  skills: [skillFromFile("./skills/deliveroo-order")],
  providers: [
    {
      id: "z-ai",
      model: "z-ai/glm-4.7",
      key: secret("Z_AI_API_KEY"),
    },
  ],
  preview: {
    slack: { enabled: true, surfaces: ["dm", "channel"], codeTtlMinutes: 15 },
  },
  network: {
    // Deliveroo is a flat allow rather than LLM-judged: the egress judge needs
    // an ANTHROPIC_API_KEY (OAuth tokens are rejected for direct API use), and
    // the deliveroo-order skill's script has no checkout/payment path, so the
    // per-request judge was defense-in-depth we opt out of here.
    allowed: [
      "api.z.ai",
      ".z.ai",
      "registry.npmjs.org",
      ".npmjs.org",
      "playwright.azureedge.net",
      "cdn.playwright.dev",
      "deliveroo.co.uk",
      ".deliveroo.co.uk",
      "deliveroo.com",
      ".deliveroo.com",
    ],
  },
});

const lunchRun = defineEntityType({
  key: "lunch-run",
  name: "Lunch run",
  description:
    "One day's office lunch order — who's in, what they ordered, the restaurant, the basket link, and where it ended up",
  required: ["date", "channel", "status"],
  properties: {
    date: {
      type: "string",
      description: "ISO date of the run (one run per day)",
      "x-table-label": "Date",
      "x-table-column": true,
    },
    channel: {
      type: "string",
      description: "The chat channel/conversation the run happened in",
      "x-table-label": "Channel",
    },
    status: {
      type: "string",
      enum: ["collecting", "done", "cancelled"],
      "x-table-label": "Status",
      "x-table-column": true,
    },
    restaurant: {
      type: "string",
      "x-table-label": "Restaurant",
      "x-table-column": true,
    },
    thread_ref: {
      type: "string",
      description:
        "Reference to the thread/message where the run is happening — lunch-finalize uses this to find the conversation",
    },
    items: {
      type: "array",
      description: "Per-person order lines",
      items: {
        type: "object",
        properties: {
          person: { type: "string" },
          item: { type: "string" },
          price: { type: "number" },
          notes: { type: "string" },
        },
      },
    },
    subtotal: {
      type: "number",
      "x-table-label": "Subtotal",
      "x-table-column": true,
    },
    basket_url: {
      type: "string",
      description:
        "Deliveroo group-order / basket link handed to a human, or null if placed manually",
    },
    notes: { type: "string" },
  },
});

// The office's Deliveroo connection. Feedless — it exposes only on-demand
// actions (search_restaurants / read_menu) that the lunch-finalize reaction
// drives through the paired Owletto Chrome extension. `restaurants_url` is the
// office's delivery-location restaurants list (set it to your office postcode's
// Deliveroo page — the geohash pins delivery to that address).
const deliverooConn = defineConnection({
  slug: "deliveroo-office",
  connector: "deliveroo",
  name: "Deliveroo — office",
  config: {
    restaurants_url:
      "https://deliveroo.co.uk/restaurants/london/the-city?fulfillment_method=DELIVERY&geohash=gcpvjcnm9jsv",
  },
});

const lunchOpen = defineWatcher({
  agent: foodOrdering,
  slug: "lunch-open",
  name: "Open the lunch run",
  schedule: "0 11 * * 1-5",
  notification: { priority: "high", channel: "both" },
  tags: ["lunch", "daily"],
  minCooldownSeconds: 600,
  prompt:
    "Open today's office lunch run (step 1 in your instructions):\n\n1. Check memory for a `lunch-run` entity dated today — if one exists and isn't\n   cancelled, stop (don't open a second one).\n2. Guess who's in from recent chat activity and past `lunch-run` entities.\n3. Post the lunch call in the channel: react 🍕 / \"+1\" to join, drop restaurant\n   recommendations, options coming ~11:35, targeting ~12:30 delivery. @-mention\n   the people you think are in, but make clear anyone can join or skip.\n4. Open a thread off that message.\n5. Save a `lunch-run` entity {date, channel, status: \"collecting\", thread_ref,\n   restaurant: null, items: []} and a `lunch:opened` event linked to it.\n\nThen end — the lunch-finalize watcher takes it from here. Keep it to one short\nmessage in the channel.\n",
  extractionSchema: {
    type: "object",
    required: ["opened"],
    properties: {
      opened: {
        type: "boolean",
        description:
          "true if a new run was opened, false if one already existed",
      },
      in_office_guess: { type: "array", items: { type: "string" } },
      thread_ref: { type: "string" },
    },
  },
});

const lunchFinalize = defineWatcher({
  agent: foodOrdering,
  slug: "lunch-finalize",
  name: "Collect orders and hand off",
  schedule: "35 11 * * 1-5",
  notification: { priority: "high" },
  tags: ["lunch", "daily"],
  minCooldownSeconds: 600,
  reaction: reactionFromFile<typeof lunchDeliverooReaction>(
    "./lunch-deliveroo.reaction.ts"
  ),
  reactionsGuidance:
    "When the run ends in `placed` or `manual`, store the per-head cost back into a\n`lunch:placed` event on the lunch-run entity so the next day's lunch-open can\nread the most-recent restaurant.\n",
  prompt:
    'Finalize today\'s office lunch run (step 2 in your instructions):\n\n1. Find today\'s `lunch-run` entity (status "collecting"). If there isn\'t one,\n   open one (step 1) and stop. If it\'s already "done"/"cancelled", do nothing.\n2. Read the run\'s thread — work out who\'s in (🍕 / "+1" / put in an order) and\n   any restaurant recommendations. If nobody\'s in: post a "skipping today 👋"\n   note, set the run to "cancelled", save a `lunch:cancelled` event, stop.\n3. Pick the restaurant (a clear thread recommendation, else a usual spot from\n   USER.md, biased away from the last couple of runs).\n4. Post the call for orders: name the restaurant and its Deliveroo page. You do\n   NOT scrape the menu yourself — a live menu shortlist with real prices is\n   fetched and posted automatically right after this turn (the deliveroo\n   connector reads it via the office\'s Owletto extension). Just set `restaurant`\n   so that reaction knows which one. Always accept free-text orders.\n5. Collect orders from replies + number reactions into items: [{person, item,\n   price?, notes}]. Ask directly about anything ambiguous — don\'t guess silently.\n6. Post the summary in the thread: restaurant; per-person list (@person — item\n   (notes)); subtotal + per-head (flag if well over budget); and the next action\n   — "@here someone place + pay on Deliveroo: <link>". The live menu + order link\n   arrive from the reaction; you never build a basket, log in, or touch payment.\n7. Update the `lunch-run` entity (status "done", restaurant, items, subtotal)\n   and save a `lunch:placed` event linked to it. Outcome is "manual" — a human\n   places + pays on Deliveroo.\n\nNever complete checkout or pay. A run is a success once the order list is\ncollected and handed off cleanly.\n',
  extractionSchema: {
    type: "object",
    required: ["outcome"],
    properties: {
      outcome: {
        type: "string",
        enum: ["placed", "manual", "cancelled", "no-run"],
        description:
          "placed = basket link handed off; manual = order list handed off without a link; cancelled = nobody in; no-run = no run existed to finalize",
      },
      restaurant: { type: "string" },
      headcount: { type: "integer" },
      subtotal: { type: "number" },
      basket_url: { type: "string" },
    },
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof DeliverooConnector>("./deliveroo.connector.ts"),
  ],
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Office-ops agents — first up: the weekday lunch order",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  agents: [foodOrdering],
  entities: [lunchRun],
  connections: [deliverooConn],
  watchers: [lunchOpen, lunchFinalize],
});

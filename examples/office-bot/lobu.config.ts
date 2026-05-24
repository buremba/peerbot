import {
  defineAgent,
  defineConfig,
  defineEntityType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";

const DELIVEROO_JUDGE =
  "Allow GET requests that read restaurant listings, menus, item details, and the\ncurrent basket. Allow POST/PUT requests whose effect is limited to building or\nmodifying a basket / group order (adding, removing, changing quantity of items;\ncreating a shareable group-order link). DENY anything that completes checkout,\nsubmits payment, reads or writes saved payment methods, changes the delivery\naddress, or modifies the account profile. If the request's effect is unclear,\nfail closed and deny with a reason.\n";

const foodOrdering = defineAgent({
  id: "food-ordering",
  name: "food-ordering",
  description:
    "Runs the office lunch order — presence check, recommendations, options poll, order collection, Deliveroo basket handoff",
  dir: "./agents/food-ordering",
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
    allowed: [
      "api.z.ai",
      ".z.ai",
      "registry.npmjs.org",
      ".npmjs.org",
      "playwright.azureedge.net",
      "cdn.playwright.dev",
    ],
    judged: [
      { domain: "deliveroo.co.uk", judge: "deliveroo" },
      { domain: ".deliveroo.co.uk", judge: "deliveroo" },
      { domain: "deliveroo.com", judge: "deliveroo" },
      { domain: ".deliveroo.com", judge: "deliveroo" },
    ],
    judges: { deliveroo: DELIVEROO_JUDGE },
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
  reactionsGuidance:
    "When the run ends in `placed` or `manual`, store the basket link + per-head cost\nback into a `lunch:placed` event on the lunch-run entity so the next day's\nlunch-open can read the most-recent restaurant.\n",
  prompt:
    'Finalize today\'s office lunch run (step 2 in your instructions):\n\n1. Find today\'s `lunch-run` entity (status "collecting"). If there isn\'t one,\n   open one (step 1) and stop. If it\'s already "done"/"cancelled", do nothing.\n2. Read the run\'s thread — work out who\'s in (🍕 / "+1" / put in an order) and\n   any restaurant recommendations. If nobody\'s in: post a "skipping today 👋"\n   note, set the run to "cancelled", save a `lunch:cancelled` event, stop.\n3. Pick the restaurant (a clear thread recommendation, else a usual spot from\n   USER.md, biased away from the last couple of runs).\n4. Post the options — if the deliveroo-order skill can scrape the menu, a\n   numbered shortlist of ~5–8 popular items with prices; otherwise just name\n   the restaurant (a link to its Deliveroo page is fine). Always accept\n   free-text orders.\n5. Collect orders from replies + number reactions into items: [{person, item,\n   price?, notes}]. Ask directly about anything ambiguous — don\'t guess silently.\n6. Build the Deliveroo basket via the deliveroo-order skill (login with stored\n   cookies → add items → group-order/basket link + subtotal). If it fails for\n   any reason, fall back: basket_url = null, continue.\n7. Post the summary in the thread: restaurant; per-person list (@person — item\n   (notes)); subtotal + per-head (flag if well over budget); the basket link if\n   you have one; and the next action — "@here someone hit checkout & pay:\n   <link>" or, with no link, "@here someone needs to place this manually".\n8. Update the `lunch-run` entity (status "done", restaurant, items, subtotal,\n   basket_url) and save a `lunch:placed` event linked to it.\n\nNever complete checkout or pay. A run with no basket automation is still a\nsuccess if the order list got collected and handed off cleanly.\n',
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
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Office-ops agents — first up: the weekday lunch order",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  agents: [foodOrdering],
  entities: [lunchRun],
  watchers: [lunchOpen, lunchFinalize],
});

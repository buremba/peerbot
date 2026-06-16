---
name: deliveroo-order
description: Turn collected lunch orders into a clean per-person order list for a human to place on Deliveroo. Use in step 2 of the lunch run, after orders are collected. The live menu is fetched automatically by the lunch-finalize reaction (via the Owletto Chrome extension) — this skill never places an order or touches payment.
---

# Deliveroo lunch order

Deliveroo menus are read **on demand** by the **`deliveroo` connector**, which
drives the office's signed-in Chrome via the paired **Owletto extension** (no
Playwright, no cookies — see `deliveroo.connector.ts`). The connector exposes
two on-demand actions, not a feed:

- `search_restaurants({ query })` — restaurants near the office matching the
  query, each as `{ name, url }`.
- `read_menu({ restaurant_url })` — that restaurant's live menu items
  (`{ name, price, price_minor, description, kcal }`).

These actions need the watcher's system context, so the **agent does not call
them in-turn** — the `lunch-finalize` **reaction** does (see
`lunch-deliveroo.reaction.ts`). After the agent's turn picks a restaurant, the
reaction searches for it, reads the live menu, and posts the menu + Deliveroo
order link back into the channel for a human to place.

This skill is **assemble + hand-off only**. It does not drive a basket, place an
order, or touch payment — a human does the checkout on Deliveroo.

## How the agent uses it

1. **Pick the restaurant** for today (from thread suggestions, or a usual spot
   in `USER.md`), and put its name in the run's extraction (`restaurant`). The
   reaction will fetch that restaurant's live menu automatically.
2. **Collect orders** in the thread, then write the per-person list into the
   `lunch-run` entity (who ordered what, with notes), and post a clean summary:
   each person → item → price, plus the subtotal and a per-head check against
   the `USER.md` budget.
3. **Hand off to a human**: `@here` someone with the restaurant link and the
   order list, and ask them to place and pay for it on Deliveroo. Record the
   restaurant + basket status on the `lunch-run` entity (`basket_url: null`
   until a human shares the group-order link, if they make one).

The reaction's live-menu post (with exact item names + prices straight off
Deliveroo) lands in the thread alongside your summary — use it to sanity-check
prices, or let people reorder against it.

## When the menu isn't available

If the reaction can't fetch a menu (no paired Owletto extension online, the
office account isn't signed into Deliveroo, or no restaurant matched), it logs
and skips — that's expected, not an error. **Fall back to the manual order
list** (see `SOUL.md` step 6) and say so. The order still gets collected and
handed off; only the auto-fetched live menu is missing. To change the office
delivery location, edit `restaurants_url` on the `deliveroo-office` connection
in `lobu.config.ts`.

## What this skill must never do

Place or complete an order, enter or read payment details, change the delivery
address, or edit the Deliveroo account. It only reads menus and assembles a list
for a human to act on.

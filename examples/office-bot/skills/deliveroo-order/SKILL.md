---
name: deliveroo-order
description: Read a restaurant's Deliveroo menu and assemble a group-order basket for the office lunch. Use in step 2 of the lunch run, after orders are collected. Reading menus and building a basket is allowed; completing checkout or touching payment is NOT.
nixPackages:
  - chromium
network:
  allow:
    - registry.npmjs.org
    - .npmjs.org
    - playwright.azureedge.net
    - cdn.playwright.dev
  judge:
    - domain: deliveroo.co.uk
      judge: deliveroo
    - domain: .deliveroo.co.uk
      judge: deliveroo
    - domain: deliveroo.com
      judge: deliveroo
    - domain: .deliveroo.com
      judge: deliveroo
judges:
  deliveroo: >
    Allow GET requests that read restaurant listings, menus, item details, and
    the current basket. Allow POST/PUT requests whose effect is limited to
    building or modifying a basket / group order (add, remove, change quantity;
    create a shareable group-order link). DENY anything that completes checkout,
    submits payment, reads or writes saved payment methods, changes the delivery
    address, or modifies the account profile. If the effect is unclear, fail
    closed and deny with a reason.
---

# Deliveroo group order

This skill bundles a small browser script — `deliveroo.ts`, next to this file — that drives a headless Chromium against Deliveroo using the office account's stored cookies. The agent shells out to it; the script never completes checkout or touches payment.

> **Status: spike.** Deliveroo has no public API, the site changes, and the group-order URL shape may be web-only / short-lived. The script does its best and exits non-zero on anything it can't do. **When it fails, the lunch run falls back to a manual order list** (see `SOUL.md` step 6) — that's expected, not a bug. Hardening the selectors is the Phase 0 follow-up.

## Auth

Cookies come from `lobu memory browser-auth --connector deliveroo --auth-profile-slug office`. The script reads them from the path in `$DELIVEROO_COOKIES` (defaults to `./deliveroo-cookies.json` in the worker workspace). If the file is missing or the session is expired, the script exits with code `3` — treat that as "fall back to manual".

## Commands

Run with `bun` (or `node` via tsx — `bun` is simplest):

```bash
# 1. Find a restaurant (slug/URL) near the office delivery address
bun deliveroo.ts search "franco manca"            # → prints candidate {name, url}

# 2. Read a menu — numbered, with prices, ready to show in the thread
bun deliveroo.ts menu "<restaurant-url>"           # → JSON [{n, name, price, id}]
bun deliveroo.ts menu "<restaurant-url>" --top 8   # popular shortlist only

# 3. Build the basket from collected orders
bun deliveroo.ts basket "<restaurant-url>" orders.json
#   orders.json = [{ "person": "Burak", "item": "Pizza name", "notes": "no onions" }, ...]
#   → prints { basketUrl, subtotal, lines: [{person, item, matched, price}] }
#   (stops at the basket — does NOT check out)

# Always-safe rehearsal: prints what it would do, never opens a browser, no cookies needed
bun deliveroo.ts basket "<restaurant-url>" orders.json --dry-run
```

## How the agent uses it (recap)

1. After picking the restaurant, `search` (if you only have a name) → `menu --top 8` → post the shortlist in the thread.
2. After orders are in, write `orders.json` and run `basket`.
3. On a clean run, post `basketUrl` + `subtotal` in the summary and `@here` someone to check out and pay.
4. On **any** non-zero exit (code `3` = auth, anything else = scrape/layout failure), skip the basket, post the per-person order list, and tell people to place it manually. Note it in the `lunch-run` entity (`basket_url: null`).

## What this skill must never do

Complete an order, enter or read payment details, change the delivery address, or edit the account profile. The egress judge enforces this at the network layer; the script also simply has no checkout path.

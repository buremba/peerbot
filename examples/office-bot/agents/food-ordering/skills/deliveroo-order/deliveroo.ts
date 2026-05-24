#!/usr/bin/env bun
/**
 * deliveroo.ts — office-lunch group-order helper (SPIKE).
 *
 * Drives headless Chromium against Deliveroo with the office account's stored
 * cookies. Reads menus and builds a basket; it has NO checkout path and never
 * touches payment. Deliveroo has no public API and the site changes — selectors
 * here are best-effort; on anything it can't do the script exits non-zero and
 * the lunch run falls back to a manual order list (see SOUL.md step 6).
 *
 * Usage:
 *   bun deliveroo.ts search "<name>"
 *   bun deliveroo.ts menu   "<restaurant-url>" [--top N]
 *   bun deliveroo.ts basket "<restaurant-url>" <orders.json> [--dry-run]
 *
 * Exit codes: 0 ok · 2 bad usage · 3 auth (missing/expired cookies) · 1 anything else.
 *
 * Cookies: $DELIVEROO_COOKIES (default ./deliveroo-cookies.json), as written by
 *   `lobu memory browser-auth --connector deliveroo --auth-profile-slug office`.
 */

import { readFileSync, existsSync } from "node:fs";

type OrderLine = { person: string; item: string; notes?: string };
type MenuItem = { n: number; name: string; price: number; id?: string };

const COOKIES_PATH = process.env.DELIVEROO_COOKIES ?? "./deliveroo-cookies.json";
const BASE = "https://deliveroo.co.uk";

function die(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

function loadCookies(): Array<Record<string, unknown>> {
  if (!existsSync(COOKIES_PATH)) {
    die(3, `auth: no cookie file at ${COOKIES_PATH} — run \`lobu memory browser-auth --connector deliveroo --auth-profile-slug office\``);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
  } catch {
    die(3, `auth: ${COOKIES_PATH} is not valid JSON`);
  }
  const cookies = Array.isArray(parsed)
    ? parsed
    : (parsed as { cookies?: unknown[] })?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    die(3, `auth: ${COOKIES_PATH} has no cookies`);
  }
  const now = Date.now() / 1000;
  const session = cookies.find(
    (c) => typeof c === "object" && c && /roo_session|session|sid/i.test(String((c as { name?: unknown }).name)),
  ) as { expires?: number } | undefined;
  if (session?.expires && session.expires < now) {
    die(3, `auth: Deliveroo session cookie expired — re-run \`lobu memory browser-auth ...\``);
  }
  return cookies as Array<Record<string, unknown>>;
}

async function withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  // Dynamic import so `--dry-run` works without playwright installed.
  const { chromium } = await import("playwright").catch(() =>
    die(1, "playwright not installed — `bun add playwright && bunx playwright install chromium` (or enable the chromium nix package)"),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(loadCookies() as unknown as Parameters<typeof context.addCookies>[0]);
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function cmdSearch(name: string): Promise<void> {
  if (!name) die(2, "usage: deliveroo.ts search \"<name>\"");
  await withPage(async (page) => {
    await page.goto(`${BASE}/restaurants?q=${encodeURIComponent(name)}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const cards = await page.locator('a[href*="/menu/"]').all();
    const out: Array<{ name: string; url: string }> = [];
    for (const card of cards.slice(0, 8)) {
      const href = await card.getAttribute("href");
      const text = (await card.innerText().catch(() => ""))?.split("\n")[0]?.trim();
      if (href) out.push({ name: text || href, url: href.startsWith("http") ? href : BASE + href });
    }
    if (out.length === 0) die(1, `search: no restaurants matched "${name}" — try the Deliveroo URL directly`);
    console.log(JSON.stringify(out, null, 2));
  });
}

async function cmdMenu(url: string, top?: number): Promise<void> {
  if (!url) die(2, "usage: deliveroo.ts menu \"<restaurant-url>\" [--top N]");
  await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Deliveroo menu items: heuristic — a name node near a price node. Selectors
    // drift; if this finds nothing, the caller falls back to "name the restaurant".
    const items = await page.evaluate(() => {
      const priceRe = /£\s?\d+(?:\.\d{2})?/;
      const results: Array<{ name: string; price: number }> = [];
      const seen = new Set<string>();
      document.querySelectorAll<HTMLElement>('[data-testid*="menu-item"], li, article').forEach((el) => {
        const text = el.innerText?.trim();
        if (!text) return;
        const m = text.match(priceRe);
        if (!m) return;
        const name = text.split("\n")[0]?.trim();
        if (!name || name.length > 80 || seen.has(name)) return;
        const price = Number(m[0].replace(/[£\s]/g, ""));
        if (!price) return;
        seen.add(name);
        results.push({ name, price });
      });
      return results;
    });
    if (items.length === 0) die(1, `menu: couldn't parse items at ${url} — caller should just name the restaurant`);
    const sliced = top && top > 0 ? items.slice(0, top) : items;
    const menu: MenuItem[] = sliced.map((it, i) => ({ n: i + 1, name: it.name, price: it.price }));
    console.log(JSON.stringify(menu, null, 2));
  });
}

function readOrders(path: string): OrderLine[] {
  if (!path || !existsSync(path)) die(2, `usage: deliveroo.ts basket "<url>" <orders.json> — file not found: ${path}`);
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(data) || data.length === 0) die(2, `${path}: expected a non-empty array of {person, item, notes?}`);
  return data as OrderLine[];
}

async function cmdBasket(url: string, ordersPath: string, dryRun: boolean): Promise<void> {
  if (!url) die(2, 'usage: deliveroo.ts basket "<restaurant-url>" <orders.json> [--dry-run]');
  const orders = readOrders(ordersPath);

  if (dryRun) {
    // Rehearsal: no browser, no cookies — just echo the plan.
    console.log(JSON.stringify({
      dryRun: true,
      restaurant: url,
      basketUrl: null,
      subtotal: null,
      lines: orders.map((o) => ({ person: o.person, item: o.item, notes: o.notes ?? null, matched: null, price: null })),
      note: "dry run — re-run without --dry-run (and with cookies) to actually build the basket",
    }, null, 2));
    return;
  }

  await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const lines: Array<{ person: string; item: string; matched: boolean; price: number | null }> = [];
    for (const order of orders) {
      // Find the item by visible text, open it, add to basket. Modifiers/notes
      // are not automated — they go in the human-readable summary instead.
      const link = page.getByText(order.item, { exact: false }).first();
      const found = await link.count().then((c) => c > 0).catch(() => false);
      if (!found) { lines.push({ person: order.person, item: order.item, matched: false, price: null }); continue; }
      try {
        await link.click({ timeout: 5_000 });
        const addBtn = page.getByRole("button", { name: /add to basket|add for/i }).first();
        await addBtn.click({ timeout: 5_000 });
        lines.push({ person: order.person, item: order.item, matched: true, price: null });
        await page.keyboard.press("Escape").catch(() => {});
      } catch {
        lines.push({ person: order.person, item: order.item, matched: false, price: null });
      }
    }
    // Try to surface a shareable group-order link if the account has group ordering on.
    let basketUrl: string | null = null;
    try {
      const share = page.getByRole("button", { name: /group order|invite|share/i }).first();
      if (await share.count()) {
        await share.click({ timeout: 5_000 });
        const linkInput = page.locator('input[value*="deliveroo"], a[href*="deliveroo"][href*="group"]').first();
        basketUrl = (await linkInput.getAttribute("value").catch(() => null)) ?? (await linkInput.getAttribute("href").catch(() => null));
      }
    } catch { /* no group-order link available — fine, caller falls back */ }
    if (basketUrl == null) basketUrl = page.url(); // at least hand back the restaurant page with the basket loaded
    const subtotalText = await page.getByText(/subtotal/i).first().innerText().catch(() => "");
    const subtotal = Number((subtotalText.match(/£\s?(\d+(?:\.\d{2})?)/)?.[1]) ?? "") || null;
    const unmatched = lines.filter((l) => !l.matched).length;
    console.log(JSON.stringify({ restaurant: url, basketUrl, subtotal, lines, unmatched }, null, 2));
    if (unmatched === lines.length) die(1, "basket: matched none of the items — caller should fall back to a manual order list");
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const args = rest.filter((a) => !a.startsWith("--"));
  const topIdx = rest.indexOf("--top");
  const top = topIdx >= 0 ? Number(rest[topIdx + 1]) : undefined;
  switch (cmd) {
    case "search": return cmdSearch(args[0] ?? "");
    case "menu":   return cmdMenu(args[0] ?? "", top);
    case "basket": return cmdBasket(args[0] ?? "", args[1] ?? "", dryRun);
    default:
      die(2, 'usage: deliveroo.ts <search|menu|basket> ... (see SKILL.md)');
  }
}

main().catch((err) => die(1, `deliveroo: ${err?.message ?? err}`));

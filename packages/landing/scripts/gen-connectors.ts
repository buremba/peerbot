#!/usr/bin/env bun
/**
 * Extracts the built-in connector list from packages/connectors source and
 * writes it as JSON importable at build time. Keeps the landing's connector
 * grid in sync with the actual connectors instead of a hand-maintained list.
 *
 * Run: bun packages/landing/scripts/gen-connectors.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as simpleIcons from "simple-icons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const connectorsDir = resolve(__dirname, "../../connectors/src");

// Source files that are not standalone connector definitions.
const SKIP = new Set(["index.ts", "browser-scraper-utils.ts"]);

// Connector key -> simple-icons slug. Only the brand association is hand-kept;
// the SVG path itself is pulled from simple-icons at generate time so logos
// stay correct/updatable. Connectors without an entry (or whose brand was
// removed from simple-icons, e.g. LinkedIn/Outlook) render a letter monogram.
const ICON_SLUGS: Record<string, string> = {
  github: "github",
  "google.gmail": "gmail",
  "google.calendar": "googlecalendar",
  gmaps: "googlemaps",
  google_play: "googleplay",
  chrome: "googlechrome",
  "chrome.bookmarks": "googlechrome",
  "chrome.downloads": "googlechrome",
  "chrome.history": "googlechrome",
  "apple.health": "apple",
  "apple.photos": "apple",
  "apple.screen_time": "apple",
  ios_appstore: "appstore",
  hackernews: "ycombinator",
  producthunt: "producthunt",
  reddit: "reddit",
  spotify: "spotify",
  youtube: "youtube",
  whatsapp: "whatsapp",
  "whatsapp.local": "whatsapp",
  x: "x",
  rss: "rss",
  trustpilot: "trustpilot",
  g2: "g2",
  glassdoor: "glassdoor",
};

function iconPathFor(key: string): string | null {
  const slug = ICON_SLUGS[key];
  if (!slug) return null;
  const exportName = `si${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
  const icon = (simpleIcons as Record<string, { path: string } | undefined>)[
    exportName
  ];
  return icon?.path ?? null;
}

interface Connector {
  key: string;
  name: string;
  /** Source file under packages/connectors/src, for the GitHub deep link. */
  file: string;
  /** simple-icons SVG path, or null when no brand mark is available. */
  iconPath: string | null;
}

function firstLiteral(source: string, field: string): string | null {
  const m = source.match(new RegExp(`${field}:\\s*["']([^"']+)["']`));
  return m ? m[1] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The connector's display name is the `name:` literal that accompanies its
// `key:` in the definition object. Other `name:` literals can appear earlier in
// the file — e.g. CSS-scrape selector configs like `name: 'componentkey'` in
// linkedin.ts — so anchor on the connector key and read the first `name:` that
// follows it instead of the first one anywhere in the source.
function connectorName(source: string, key: string): string | null {
  const keyIdx = source.search(
    new RegExp(`key:\\s*["']${escapeRegExp(key)}["']`)
  );
  if (keyIdx === -1) return firstLiteral(source, "name");
  return firstLiteral(source.slice(keyIdx), "name");
}

function extractConnectors(): Connector[] {
  const files = readdirSync(connectorsDir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !SKIP.has(f)
  );

  const found: Array<{ key: string; name: string; file: string }> = [];
  for (const file of files) {
    const source = readFileSync(resolve(connectorsDir, file), "utf-8");
    const key = firstLiteral(source, "key");
    const name = key ? connectorName(source, key) : null;
    // A file is a connector only when its definition exposes both fields.
    if (key && name) found.push({ key, name, file });
  }

  // Collapse opt-in sub-feeds (`chrome.history`, `whatsapp.local`) into their
  // parent connector when the parent is itself listed, so the logo wall shows
  // one chip per connector instead of repeating the same brand mark.
  const keys = new Set(found.map((c) => c.key));
  const connectors: Connector[] = found
    .filter((c) => {
      const base = c.key.split(".")[0];
      return !(c.key.includes(".") && base !== c.key && keys.has(base));
    })
    .map((c) => ({ ...c, iconPath: iconPathFor(c.key) }));

  connectors.sort((a, b) => a.name.localeCompare(b.name));
  return connectors;
}

const result = extractConnectors();
const outPath = resolve(__dirname, "../src/generated/connectors.json");
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${result.length} connectors to ${outPath}`);

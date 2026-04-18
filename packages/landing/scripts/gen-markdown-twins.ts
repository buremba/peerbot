#!/usr/bin/env bun
/**
 * Emits plain-markdown twins of every Starlight doc + blog post into public/
 * so that agents requesting `Accept: text/markdown` receive structured content.
 * A Cloudflare Pages Function (functions/_middleware.ts) performs the content
 * negotiation by rewriting to the <route>.md twin.
 *
 * Run: bun packages/landing/scripts/gen-markdown-twins.ts
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentRoot = resolve(__dirname, "../src/content");
const publicRoot = resolve(__dirname, "../public");

interface Entry {
  sourcePath: string;
  route: string;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (full.endsWith(".md") || full.endsWith(".mdx")) {
      acc.push(full);
    }
  }
  return acc;
}

function stripFrontmatter(raw: string): {
  body: string;
  title?: string;
  description?: string;
  draft: boolean;
} {
  if (!raw.startsWith("---")) return { body: raw, draft: false };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw, draft: false };
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const titleMatch = fm.match(/^title:\s*(.*)$/m);
  const descMatch = fm.match(/^description:\s*(.*)$/m);
  const draftMatch = fm.match(/^draft:\s*(.*)$/m);
  const draft = draftMatch?.[1]?.trim().toLowerCase() === "true";
  return {
    body,
    title: titleMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
    description: descMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
    draft,
  };
}

function stripMdxImports(body: string): string {
  return body
    .replace(/^import\s+[^;]+;\s*$/gm, "")
    .replace(/^\s*\n(\s*\n)+/gm, "\n\n");
}

function routeFor(sourceAbs: string): string {
  const rel = relative(contentRoot, sourceAbs).replace(/\\/g, "/");
  let route = rel
    .replace(/^docs\//, "")
    .replace(/\.(md|mdx)$/, "")
    .replace(/\/index$/, "");
  if (!route) route = "index";
  return route;
}

const entries: Entry[] = walk(contentRoot).map((sourcePath) => ({
  sourcePath,
  route: routeFor(sourcePath),
}));

let written = 0;
let skipped = 0;
for (const { sourcePath, route } of entries) {
  const raw = readFileSync(sourcePath, "utf-8");
  const { body, title, description, draft } = stripFrontmatter(raw);
  if (draft) {
    skipped++;
    continue;
  }
  const clean = stripMdxImports(body).trim();
  const header = [
    title ? `# ${title}` : null,
    description ? `> ${description}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const md = `${[header, clean].filter(Boolean).join("\n\n")}\n`;

  const outPath = join(publicRoot, `${route}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf-8");
  written++;
}

console.log(
  `gen-markdown-twins: wrote ${written} files (${skipped} drafts skipped) to ${publicRoot}`
);

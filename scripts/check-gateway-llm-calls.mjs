#!/usr/bin/env node
// Prevent new, unsuppressed per-feature LLM transports in packages/server.
// Suggestion chips and query rewriting share gateway-completion.ts. The
// existing fail-closed egress judge remains explicitly suppressed pending its
// own migration and red→green coverage.
//
// COVERAGE (textual, deliberately — see HONEST GAP):
//   1. `fetch(...)` whose URL expression mentions a completions-style path
//      (/chat/completions, /v1/messages, /completions, /responses).
//   2. Importing a vendor SDK (@anthropic-ai/sdk, openai, @google/generative-ai,
//      @mistralai/*, cohere-ai, groq-sdk, replicate) anywhere outside the
//      allowlisted module.
//   3. Declaring a new per-feature credential triple: an identifier or string
//      matching <PREFIX>_API_KEY where a sibling <PREFIX>_BASE_URL or
//      <PREFIX>_MODEL also appears in the same file.
//
// HONEST GAP: this is textual, not type-aware — a call assembled through enough
// indirection (a URL built far from the fetch, an SDK re-exported by a local
// module) will not be caught. The durable backstop for those is review plus the
// fact that a NEW credential triple is itself flagged, and a hand-rolled client
// needs credentials from somewhere. It also does not scan packages outside
// packages/server; agent-worker legitimately owns model routing (pi-ai).
//
// Escape hatch: put `gateway-llm-ok` in a comment on the flagged line (or the
// line above) with a reason.
//
// No DB, no build — pure static text analysis.
// Run: `node scripts/check-gateway-llm-calls.mjs`.

import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SRC = join(REPO_ROOT, "packages/server/src");

// The ONE module allowed to speak HTTP to a model provider. Its whole job is
// being that seam, so it necessarily contains the patterns this gate forbids.
const ALLOWED_CLIENT =
  "packages/server/src/gateway/inference/gateway-completion.ts";

// `gateway/auth/**` is a DIFFERENT concern and is exempt from the credential-
// triple rule (it is still subject to the fetch + SDK rules). Those modules
// hand a credential to the agent's own CLI subprocess — they build the env a
// spawned `claude`/`codex` process reads, so naming ANTHROPIC_API_KEY /
// OPENAI_API_KEY is their whole job, not a hand-rolled transport. The gate is
// about the SERVER calling a model itself; forwarding a credential to the run
// path is exactly what it should keep doing.
const CREDENTIAL_RULE_EXEMPT_DIRS = ["packages/server/src/gateway/auth/"];

// Vendor SDKs that imply a hand-rolled, provider-pinned transport.
const VENDOR_SDKS = [
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "groq-sdk",
  "replicate",
  "@mistralai/mistralai",
];

// Completion-ish endpoint paths. `/embeddings` is deliberately ABSENT: the
// embeddings package owns that path and it is not a chat completion.
const COMPLETION_PATHS = [
  "/chat/completions",
  "/v1/messages",
  "/responses",
  "/completions",
];

const violations = [];

/**
 * Suppressed if the flagged line carries `gateway-llm-ok`, or if the comment
 * block immediately above it does. Scanning the WHOLE contiguous comment block
 * (rather than just the previous line) is deliberate: a suppression is required
 * to state its reason, and a real reason rarely fits on one line — a
 * single-line window would push authors toward terse, uninformative excuses.
 * The scan stops at the first non-comment line, so it cannot reach across an
 * unrelated statement into some earlier block's marker.
 */
function isSuppressed(lines, idx) {
  if (/gateway-llm-ok/.test(lines[idx] ?? "")) return true;
  for (let i = idx - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const isComment =
      line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
    if (!isComment) return false;
    if (/gateway-llm-ok/.test(line)) return true;
  }
  return false;
}

function flag(file, lineNo, kind, snippet) {
  violations.push({
    file: relative(REPO_ROOT, file),
    line: lineNo,
    kind,
    snippet: snippet.trim().replace(/\s+/g, " ").slice(0, 100),
  });
}

/**
 * Find `<PREFIX>_API_KEY` occurrences that have a sibling `<PREFIX>_BASE_URL`
 * or `<PREFIX>_MODEL` in the same file — the signature of a new per-feature
 * credential triple. A lone `*_API_KEY` is NOT flagged: plenty of legitimate
 * non-LLM integrations carry one.
 */
function findCredentialTriples(text) {
  const keys = new Set();
  const siblings = new Set();
  for (const m of text.matchAll(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_API_KEY\b/g
  )) {
    keys.add(m[1]);
  }
  for (const m of text.matchAll(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_(?:BASE_URL|MODEL)\b/g
  )) {
    siblings.add(m[1]);
  }
  return [...keys].filter((k) => siblings.has(k));
}

let scannedCount = 0;
const files = globSync("**/*.{ts,tsx}", { cwd: SERVER_SRC }).map((f) =>
  resolve(SERVER_SRC, f)
);

for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  if (rel === ALLOWED_CLIENT) continue;
  // Tests legitimately construct fake upstreams and stub vendor clients.
  if (rel.includes("/__tests__/")) continue;
  if (file.endsWith(".d.ts")) continue;
  scannedCount++;

  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  const credentialRuleApplies = !CREDENTIAL_RULE_EXEMPT_DIRS.some((d) =>
    rel.startsWith(d)
  );
  const triples = credentialRuleApplies ? findCredentialTriples(text) : [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip comments so prose ABOUT the old design (a historical note, a
    // migration comment, a doc block naming the env var a module forwards)
    // does not trip the gate. Covers `// …`, a jsdoc continuation line `* …`,
    // and a single-line `/** … */`.
    const code = line
      .replace(/\/\*\*?.*?\*\//g, "")
      .replace(/\/\/.*$/, "")
      .replace(/^\s*\*.*$/, "")
      .replace(/^\s*\/\*.*$/, "");
    if (!code.trim()) continue;
    if (isSuppressed(lines, i)) continue;

    // 1. fetch() to a completions-style path.
    if (/\bfetch\s*\(/.test(code)) {
      for (const p of COMPLETION_PATHS) {
        if (code.includes(p)) {
          flag(file, i + 1, "hand-rolled completion fetch", line);
          break;
        }
      }
    }

    // 2. Vendor SDK import.
    if (/\b(?:import|require)\b/.test(code)) {
      for (const sdk of VENDOR_SDKS) {
        if (
          code.includes(`"${sdk}"`) ||
          code.includes(`'${sdk}'`) ||
          code.includes(`"${sdk}/`) ||
          code.includes(`'${sdk}/`)
        ) {
          flag(file, i + 1, `vendor SDK import (${sdk})`, line);
          break;
        }
      }
    }

    // 3. New per-feature credential triple.
    for (const prefix of triples) {
      if (code.includes(`${prefix}_API_KEY`)) {
        flag(file, i + 1, `per-feature credential triple (${prefix}_*)`, line);
        break;
      }
    }
  }
}

// Guard against a vacuous green: if the glob ever stops matching, the loop
// scans nothing and would report "clean" — silently disabling the gate.
if (!existsSync(SERVER_SRC)) {
  console.error(`✗ expected ${SERVER_SRC} to exist`);
  process.exit(1);
}
if (scannedCount === 0) {
  console.error(
    "✗ gateway-llm gate scanned ZERO packages/server/src files — the glob likely\n" +
      "  regressed. A clean result here would be vacuous; failing instead."
  );
  process.exit(1);
}
if (!existsSync(join(REPO_ROOT, ALLOWED_CLIENT))) {
  console.error(
    `✗ gateway-llm gate: the shared client ${ALLOWED_CLIENT} is missing.\n` +
      "  Unsuppressed gateway LLM calls are supposed to route through it; if it moved,\n" +
      "  update ALLOWED_CLIENT in scripts/check-gateway-llm-calls.mjs."
  );
  process.exit(1);
}

if (violations.length) {
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.error(`\n✗ gateway-llm gate failed (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  [${v.kind}]`);
    console.error(`      ${v.snippet}`);
  }
  console.error(
    "\nNew packages/server LLM calls go through\n" +
      "  gateway/inference/gateway-completion.ts\n" +
      "Do not add a per-feature *_API_KEY / *_BASE_URL / *_MODEL triple or a\n" +
      "second vendor client.\n\n" +
      "If a case is genuinely safe, add a `gateway-llm-ok` comment WITH A REASON\n" +
      "on the flagged line. See scripts/check-gateway-llm-calls.mjs.\n"
  );
  process.exit(1);
}

console.log(
  `✓ gateway-llm gate: ${scannedCount} packages/server/src files contain no unsuppressed one-off LLM client`
);

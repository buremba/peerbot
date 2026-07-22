#!/usr/bin/env bun
/**
 * Guard: keep the product name "Behavior" on the agent-facing surface.
 *
 * The word "watcher" was purged from MCP/SDK/reaction contracts (→ Behaviors),
 * but nothing previously prevented a regression. This gate fails CI when
 * "watcher" reappears on the EXPOSED surface agents actually see:
 *
 *   - MCP tool input/output schemas + descriptions
 *     (packages/core/src/contracts/tools/*.ts,
 *      packages/server/src/tools/registry.ts,
 *      packages/server/src/tools/admin/index.ts)
 *   - ClientSDK discovery surface
 *     (sdk-manifest.ts, sdk-method-access.ts,
 *      namespace method NAMES under sandbox/namespaces/)
 *   - connector-sdk public reaction contract
 *     (packages/connector-sdk/src/reaction-client-types.ts)
 *
 * Scope is intentional and narrow so legitimate internal uses never trip:
 * DB table/SQL names, `ctx.actingWatcherId`, `src/watchers/`, and read-path
 * normalizers for historical append-only events live outside these paths or
 * outside the constructs we scan (e.g. comments about the `watchers` table
 * inside a contract file, camelCase internal fields).
 *
 * Source only — never dist/, never __tests__.
 *
 * Run: bun scripts/check-exposed-surface-naming.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /watcher/i;

type Violation = { file: string; line: number; excerpt: string };

function rel(abs: string): string {
  return relative(REPO_ROOT, abs);
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "dist") {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Wipe // and /* *\/ comments, preserving newlines so line numbers stay valid. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    // line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      if (j < 0) {
        out += "\n";
        break;
      }
      out += "\n";
      i = j + 1;
      continue;
    }
    // block comment
    if (src[i] === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) break;
      const chunk = src.slice(i, j + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i = j + 2;
      continue;
    }
    // string / template literal — copy through so we can still scan contents
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      out += q;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i += 1;
          break;
        }
        // template ${...} — keep scanning inside as code for simplicity
        if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
          out += "${";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth += 1;
            else if (src[i] === "}") depth -= 1;
            out += src[i];
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

function excerptAt(src: string, index: number): string {
  const lineStart = src.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = src.indexOf("\n", index);
  const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function addViolation(
  violations: Violation[],
  file: string,
  src: string,
  index: number
): void {
  violations.push({
    file: rel(file),
    line: lineOf(src, index),
    excerpt: excerptAt(src, index),
  });
}

/** Every line that contains the banned substring (comments included). */
function scanFullText(file: string, violations: Violation[]): void {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (BANNED.test(lines[i]!)) {
      violations.push({
        file: rel(file),
        line: i + 1,
        excerpt: lines[i]!.trim().slice(0, 120),
      });
    }
  }
}

/**
 * Agent-facing constructs in TypeBox contract / tool-registration files:
 *  - string / template literals (schema descriptions, tool name/description/title,
 *    enum/literal values)
 *  - snake_case property keys containing "watcher" (MCP JSON keys, e.g. watcher_source)
 *
 * Comments and camelCase internal fields (actingWatcherId) are intentionally out
 * of scope — they are not the exposed agent surface.
 */
function scanAgentFacingLiteralsAndSnakeKeys(
  file: string,
  violations: Violation[]
): void {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);

  // String / template literals
  const strRe = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const m of src.matchAll(strRe)) {
    if (BANNED.test(m[2]!)) {
      addViolation(violations, file, src, m.index);
    }
  }

  // snake_case keys only — all-lowercase with optional underscores. This matches
  // MCP/JSON schema property names and deliberately skips camelCase internals
  // like actingWatcherId.
  const keyRe = /\b([a-z][a-z0-9_]*watcher[a-z0-9_]*)\s*\??\s*:/g;
  for (const m of src.matchAll(keyRe)) {
    addViolation(violations, file, src, m.index + (m[0]!.indexOf(m[1]!) ?? 0));
  }
}

/**
 * Namespace method NAMES only (what search_sdk / the sandbox manifest advertise).
 * Comments, types, and implementation bodies are out of scope.
 */
function scanNamespaceMethodNames(file: string, violations: Violation[]): void {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Interface / type method: `  methodName(args): Promise<...>` or `methodName?: (...)`
    // Object-literal method: `  methodName: (` / `methodName(` / `async methodName(`
    const candidates = [
      /^\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*\(/,
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:async\s*)?\(/,
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    ];
    for (const re of candidates) {
      const match = re.exec(line);
      if (!match) continue;
      const name = match[1]!;
      // Skip control / keyword-looking noise
      if (
        name === "if" ||
        name === "for" ||
        name === "while" ||
        name === "switch" ||
        name === "catch" ||
        name === "function" ||
        name === "return" ||
        name === "typeof" ||
        name === "await" ||
        name === "import" ||
        name === "export" ||
        name === "from" ||
        name === "new" ||
        name === "super" ||
        name === "constructor"
      ) {
        continue;
      }
      if (BANNED.test(name)) {
        violations.push({
          file: rel(file),
          line: i + 1,
          excerpt: line.trim().slice(0, 120),
        });
      }
      break;
    }
  }
}

// ── Collect surfaces ─────────────────────────────────────────────────────────

const violations: Violation[] = [];

// Pure public surface — full text (JSDoc is part of the published contract)
for (const file of [
  join(REPO_ROOT, "packages/connector-sdk/src/reaction-client-types.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-manifest.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-method-access.ts"),
]) {
  scanFullText(file, violations);
}

// TypeBox contracts — literals + snake_case keys
const contractsDir = join(REPO_ROOT, "packages/core/src/contracts/tools");
for (const file of collectTsFiles(contractsDir)) {
  scanAgentFacingLiteralsAndSnakeKeys(file, violations);
}

// Tool registry + admin tool descriptions/names
for (const file of [
  join(REPO_ROOT, "packages/server/src/tools/registry.ts"),
  join(REPO_ROOT, "packages/server/src/tools/admin/index.ts"),
]) {
  scanAgentFacingLiteralsAndSnakeKeys(file, violations);
}

// ClientSDK namespace method names
const namespacesDir = join(REPO_ROOT, "packages/server/src/sandbox/namespaces");
for (const file of collectTsFiles(namespacesDir)) {
  scanNamespaceMethodNames(file, violations);
}

// Dedupe (same line can match key + string)
const seen = new Set<string>();
const unique = violations.filter((v) => {
  const k = `${v.file}:${v.line}:${v.excerpt}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (unique.length > 0) {
  console.error(
    `check-exposed-surface-naming: "watcher" is banned on the agent-facing surface ` +
      `(use Behavior / behavior_*). Found ${unique.length} occurrence(s):\n`
  );
  for (const v of unique) {
    console.error(`  ${v.file}:${v.line}: ${v.excerpt}`);
  }
  console.error(
    `\nScope: MCP tool contracts/descriptions, ClientSDK discovery names, ` +
      `and the public reaction client types. Internal engine names (DB, ` +
      `actingWatcherId, src/watchers/) are out of scope by design.`
  );
  process.exit(1);
}

console.log(
  "check-exposed-surface-naming: clean — no agent-facing 'watcher' on exposed surface."
);

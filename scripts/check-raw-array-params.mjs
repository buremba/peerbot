#!/usr/bin/env node
// Guard against the raw-JS-array query-param bug class (the fetch_types:false trap).
//
// packages/server's postgres.js client runs with `fetch_types:false`
// (PROD_PG_VALUE_OPTIONS, db/client.ts). Under that option postgres.js CANNOT
// auto-serialize a raw JavaScript array bound as a query parameter — it emits a
// malformed array literal and Postgres rejects the query. This is true for BOTH
// number[] and string[], in BOTH the tagged template (`sql`...${arr}...``) and
// `sql.unsafe(q, [arr])`, WITH OR WITHOUT a `::type[]` cast. The ONLY correct
// ways to bind an array are:
//   - `pgTextArray(arr)`   bound to `$N::text[]`     (returns a pg-literal string)
//   - `pgBigintArray(arr)` bound to `$N::bigint[]`   (returns a pg-literal string)
//   - `sql.array(arr)` / `sql.json(arr)` / `JSON.stringify(arr)` (jsonb) — not array-typed
//   - an `ARRAY[$a,$b,...]` constructor over SCALAR params
// Because pgTextArray()/pgBigintArray()/sql.array()/JSON.stringify() all return a
// non-array (string/Fragment), the signal is simple and precise:
//
//   *** A value whose STATIC TYPE is a JS array, bound as a SQL parameter, is a bug. ***
//
// This was a real, prod-reproducing, SILENT outage class: the failing path's only
// caller swallowed the error, so it never surfaced. A type-aware static gate makes
// it a hard CI failure at PR time.
//
// COVERAGE (type-aware, via the TS checker — handles `string[]`, `number[]`,
// `Array.from(...)`, `.map()/.filter()/.slice()`, `T[]` params, unions, tuples):
//   1. Tagged template:   sql`... ${arrayTypedExpr} ...`            (the common idiom)
//   2. unsafe array-lit:  sql.unsafe(q, [ ..., arrayTypedExpr, ...])
//   3. Builder/consumer (where the worst real bugs hid — a params array is built in
//      a helper and consumed by `.unsafe()` elsewhere):
//        a. P.push(arrayTypedExpr) / P.unshift(arrayTypedExpr)
//        b. const P = items.flatMap(x => [ ..., arrayTypedExpr, ... ])
//      where P is a "param sink" = an identifier passed as the 2nd arg of a
//      `sql.unsafe(...)` call OR the value of a `params:` property the file returns.
//
// HONEST GAP: a raw array reaching a param through a sink this file can't connect
// (e.g. cross-module, or a param typed `any`) is NOT caught here — the durable
// backstop for those is TEST COVERAGE of the query path (so the malformed array is
// exercised) plus reviewer attention. Escape hatch: put `raw-array-ok` in a comment
// on the flagged line (or the line above) for a genuinely-safe case.
//
// No DB, no build — pure static analysis. Run: `node scripts/check-raw-array-params.mjs`.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(REPO_ROOT, "packages/server");
const SERVER_SRC = join(SERVER_DIR, "src");
const TSCONFIG = join(SERVER_DIR, "tsconfig.json");

// The two repo helpers that return a pg-literal STRING. They're already safe via
// the type check (string is not array-like); this name-skip is belt-and-suspenders
// against a future signature change. NOT listed: sql.array()/sql.json()/
// JSON.stringify() — they return non-array types so the type check passes them
// anyway, and matching the bare names `array`/`json`/`stringify` would wrongly
// skip an unrelated user function of the same name that returns a raw array.
const SAFE_CALLEES = new Set(["pgTextArray", "pgBigintArray"]);

// Property names treated as a query-param sink when their value is an identifier
// that an array-typed value is later pushed into (the builder/consumer pattern).
const PARAM_PROP_NAMES = new Set(["params", "parameters", "binds"]);

function loadProgram() {
  const raw = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(raw.error.messageText, "\n")
    );
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, SERVER_DIR);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
  });
  return { program, checker: program.getTypeChecker() };
}

const { program, checker } = loadProgram();

/** True if `type` is (or unions/intersects to) a JS array / tuple — but not a string. */
function isArrayLikeType(type) {
  if (!type) return false;
  if (type.isUnion?.() || type.isIntersection?.()) {
    return type.types.some(isArrayLikeType);
  }
  // string has a numeric index signature too, so name/tuple checks must come first.
  const name = (type.aliasSymbol || type.getSymbol())?.getName();
  if (name === "Array" || name === "ReadonlyArray" || name === "ConcatArray")
    return true;
  // Tuple / array-type checks via the checker (guarded — these exist at runtime
  // but are not in every .d.ts; fall back gracefully if absent).
  try {
    if (typeof checker.isTupleType === "function" && checker.isTupleType(type))
      return true;
    if (typeof checker.isArrayType === "function" && checker.isArrayType(type))
      return true;
  } catch {
    // ignore — name check above already covers the overwhelming majority
  }
  return false;
}

/** A `sql` client type has the postgres.js trio: unsafe + array + json. */
function isSqlClientType(type) {
  if (!type) return false;
  return (
    !!type.getProperty?.("unsafe") &&
    !!type.getProperty?.("array") &&
    !!type.getProperty?.("json")
  );
}

/** Skip an expression that is an explicitly-safe helper call. */
function isSafeHelperCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : undefined;
  return name ? SAFE_CALLEES.has(name) : false;
}

/** Symbol identity for a sink/target identifier (stable per declaration in a file).
 *  Note: a one-level alias (`const p = params`) is NOT followed — `p` and `params`
 *  resolve to distinct symbols. That narrow case is a documented limitation. */
function symbolOf(node) {
  if (!node || !ts.isIdentifier(node)) return undefined;
  return checker.getSymbolAtLocation(node);
}

/** The array-literal expressions a map/flatMap/concat callback yields (concise or block body). */
function returnedArrayLiterals(node) {
  const out = [];
  if (!ts.isCallExpression(node)) return out;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return out;
  const method = callee.name.text;
  if (method === "concat") {
    for (const arg of node.arguments)
      if (ts.isArrayLiteralExpression(arg)) out.push(arg);
    return out;
  }
  if (method !== "map" && method !== "flatMap") return out;
  const cb = node.arguments[0];
  if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)))
    return out;
  const body = cb.body;
  if (ts.isArrayLiteralExpression(body)) {
    out.push(body);
  } else if (body && ts.isBlock(body)) {
    const visit = (n) => {
      if (ts.isFunctionLike(n)) return; // don't descend into nested closures
      if (
        ts.isReturnStatement(n) &&
        n.expression &&
        ts.isArrayLiteralExpression(n.expression)
      ) {
        out.push(n.expression);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  }
  return out;
}

const violations = [];

function lineText(sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const lines = sourceFile.text.split("\n");
  return {
    line,
    text: lines[line] ?? "",
    prev: line > 0 ? (lines[line - 1] ?? "") : "",
  };
}

function isSuppressed(sourceFile, node) {
  const { text, prev } = lineText(sourceFile, node);
  return /raw-array-ok/.test(text) || /raw-array-ok/.test(prev);
}

function flag(sourceFile, node, kind) {
  if (isSuppressed(sourceFile, node)) return;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart()
  );
  const typeText = checker.typeToString(checker.getTypeAtLocation(node));
  const rel = node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 80);
  violations.push({
    file: sourceFile.fileName,
    line: line + 1,
    col: character + 1,
    kind,
    typeText,
    snippet: rel,
  });
}

/** Flag `node` if its static type is array-like and it isn't a safe helper call. */
function checkBinding(sourceFile, node, kind) {
  if (!node) return;
  // A spread (`...arr`, `push(...arr)`, `[...a, ...b]`) FLATTENS the array into
  // separate scalar params — that is the CORRECT way to compose a param list, not
  // a bug. Only a non-spread array-typed value is a single malformed array param.
  if (ts.isSpreadElement(node)) return;
  if (isSafeHelperCall(node)) return;
  let type;
  try {
    type = checker.getTypeAtLocation(node);
  } catch {
    return;
  }
  if (isArrayLikeType(type)) flag(sourceFile, node, kind);
}

let scannedCount = 0;
for (const sourceFile of program.getSourceFiles()) {
  const f = sourceFile.fileName;
  if (sourceFile.isDeclarationFile) continue;
  if (!f.includes("/packages/server/src/")) continue;
  if (f.includes("/__tests__/")) continue;
  scannedCount++;

  // ── Pass 1: collect param-sink symbols (consumers + returned `params:` props) ──
  const sinkSymbols = new Set();
  const collectSinks = (node) => {
    // sql.unsafe(query, SINK) → 2nd arg identifier is a sink
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "unsafe" &&
      isSqlClientType(checker.getTypeAtLocation(node.expression.expression))
    ) {
      const second = node.arguments[1];
      const sym = symbolOf(second);
      if (sym) sinkSymbols.add(sym);
    }
    // { params: SINK } / { parameters: SINK } / { binds: SINK }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      PARAM_PROP_NAMES.has(node.name.text)
    ) {
      const sym = symbolOf(node.initializer);
      if (sym) sinkSymbols.add(sym);
    }
    // shorthand { params } → the property symbol's value
    if (
      ts.isShorthandPropertyAssignment(node) &&
      PARAM_PROP_NAMES.has(node.name.text)
    ) {
      const sym = checker.getShorthandAssignmentValueSymbol?.(node);
      if (sym) sinkSymbols.add(sym);
    }
    ts.forEachChild(node, collectSinks);
  };
  collectSinks(sourceFile);

  // ── Pass 2: flag array-typed bindings ──
  const visit = (node) => {
    // 1. Tagged template `sql`...${x}...``
    if (
      ts.isTaggedTemplateExpression(node) &&
      isSqlClientType(checker.getTypeAtLocation(node.tag))
    ) {
      const tpl = node.template;
      if (ts.isTemplateExpression(tpl)) {
        for (const span of tpl.templateSpans)
          checkBinding(
            sourceFile,
            span.expression,
            "tagged-template substitution"
          );
      }
    }

    // 2. sql.unsafe(q, [ ...elements ]) — element-check an inline array literal
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "unsafe" &&
      isSqlClientType(checker.getTypeAtLocation(node.expression.expression))
    ) {
      const second = node.arguments[1];
      if (second && ts.isArrayLiteralExpression(second)) {
        for (const el of second.elements)
          checkBinding(sourceFile, el, "unsafe() param");
      }
    }

    // 3a. SINK.push(x) / SINK.unshift(x)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "push" ||
        node.expression.name.text === "unshift") &&
      sinkSymbols.has(symbolOf(node.expression.expression))
    ) {
      for (const arg of node.arguments)
        checkBinding(sourceFile, arg, "push into param sink");
    }

    // 3b. const SINK = items.flatMap(x => [ ...x... ])  |  const SINK = [ ... ]
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      sinkSymbols.has(symbolOf(node.name))
    ) {
      if (ts.isArrayLiteralExpression(node.initializer)) {
        for (const el of node.initializer.elements)
          checkBinding(sourceFile, el, "param-array element");
      } else {
        for (const lit of returnedArrayLiterals(node.initializer)) {
          for (const el of lit.elements)
            checkBinding(sourceFile, el, "flatMap param element");
        }
      }
    }
    // `SINK = items.flatMap(...)` assignment (not a declaration)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      sinkSymbols.has(symbolOf(node.left))
    ) {
      if (ts.isArrayLiteralExpression(node.right)) {
        for (const el of node.right.elements)
          checkBinding(sourceFile, el, "param-array element");
      } else {
        for (const lit of returnedArrayLiterals(node.right)) {
          for (const el of lit.elements)
            checkBinding(sourceFile, el, "flatMap param element");
        }
      }
    }
    // 3c. SINK[i] = x  (element assignment of an array-typed value into a sink)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      sinkSymbols.has(symbolOf(node.left.expression))
    ) {
      checkBinding(sourceFile, node.right, "param sink element assignment");
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Guard against a vacuous green: if the tsconfig globs ever stop matching
// packages/server/src, the loop scans nothing and would report "clean" — silently
// disabling the gate. The real tree resolves hundreds of files.
if (!existsSync(SERVER_SRC)) {
  console.error(`✗ expected ${SERVER_SRC} to exist`);
  process.exit(1);
}
if (scannedCount === 0) {
  console.error(
    "✗ raw-array-param gate scanned ZERO packages/server/src files — the tsconfig\n" +
      "  file globs likely regressed. A clean result here would be vacuous; failing instead."
  );
  process.exit(1);
}

if (violations.length) {
  // Stable ordering for readable diffs.
  violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col
  );
  console.error(`\n✗ raw-array-param gate failed (${violations.length}):\n`);
  for (const v of violations) {
    const rel = v.file.slice(v.file.indexOf("/packages/") + 1);
    console.error(`  - ${rel}:${v.line}:${v.col}  [${v.kind}]`);
    console.error(
      `      type ${v.typeText} bound as a SQL param: ${v.snippet}`
    );
  }
  console.error(
    "\nUnder fetch_types:false a raw JS array param serializes to a malformed array\n" +
      "literal and Postgres rejects it. Wrap it: pgTextArray(arr)/pgBigintArray(arr)\n" +
      "bound to $N::text[]/$N::bigint[], or sql.array()/JSON.stringify() for jsonb.\n" +
      "If genuinely safe, add a `raw-array-ok` comment on the flagged line.\n" +
      "See scripts/check-raw-array-params.mjs.\n"
  );
  process.exit(1);
}

console.log(
  "✓ raw-array-param gate: no JS array is bound as a SQL parameter in packages/server/src"
);

#!/usr/bin/env bun
/**
 * Guard: keep the product name "Behavior" on the agent-facing surface.
 *
 * The word "watcher" remains an internal engine/DB term, but must not appear in:
 *
 *   - MCP tool schemas, names, descriptions, or titles
 *   - ClientSDK discovery metadata, aliases, or namespace method names
 *   - the connector-sdk public reaction contract
 *
 * TypeBox schema initializers are scanned under the core tool contracts and the
 * server's tool/type sources. Other source scans are deliberately limited to
 * files whose literals are rendered into MCP or ClientSDK discovery output.
 * Comments are ignored except in the published connector-sdk declaration file,
 * where JSDoc is part of the public contract.
 *
 * Internal identifiers such as `actingWatcherId`, DB table/column names, and
 * implementation comments remain allowed outside those exposed constructs.
 * Source only — never dist/ or tests.
 *
 * Run: bun scripts/check-exposed-surface-naming.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /watcher/i;
const BANNED_SNAKE_KEY = /^[a-z0-9_]*watcher[a-z0-9_]*$/;

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

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function addViolation(
  violations: Violation[],
  file: string,
  source: ts.SourceFile,
  node: ts.Node
): void {
  const start = node.getStart(source);
  const { line } = source.getLineAndCharacterOfPosition(start);
  const text = source.text.split("\n")[line]?.trim() ?? "";
  violations.push({
    file: rel(file),
    line: line + 1,
    excerpt: text.slice(0, 120),
  });
}

function isTemplateText(node: ts.Node): node is ts.TemplateLiteralLikeNode {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function propertyName(node: ts.Node): ts.PropertyName | undefined {
  if (
    ts.isPropertyAssignment(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/** Scan exposed literals and lowercase/snake_case wire keys, excluding comments. */
function scanSyntaxNode(
  file: string,
  source: ts.SourceFile,
  root: ts.Node,
  violations: Violation[]
): void {
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || isTemplateText(node)) &&
      BANNED.test(node.text)
    ) {
      addViolation(violations, file, source, node);
    }

    const name = propertyName(node);
    const text = name && propertyNameText(name);
    if (text && BANNED_SNAKE_KEY.test(text)) {
      addViolation(violations, file, source, name);
    }

    ts.forEachChild(node, visit);
  }

  visit(root);
}

function scanExposedSyntax(file: string, violations: Violation[]): void {
  const source = parse(file);
  scanSyntaxNode(file, source, source, violations);
}

function containsTypeBoxCall(root: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Type"
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

/** Scan top-level declarations that construct TypeBox schemas, not handlers/SQL. */
function scanTypeBoxSchemas(file: string, violations: Violation[]): void {
  const source = parse(file);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && containsTypeBoxCall(initializer)) {
        scanSyntaxNode(file, source, initializer, violations);
      }
    }
  }
}

/** Public namespace interface members are the runtime-callable SDK names. */
function scanNamespaceMethods(file: string, violations: Violation[]): void {
  const source = parse(file);
  for (const statement of source.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      !statement.name.text.endsWith("Namespace")
    ) {
      continue;
    }
    for (const member of statement.members) {
      const name = propertyName(member);
      const text = name && propertyNameText(name);
      if (name && text && BANNED.test(text)) {
        addViolation(violations, file, source, name);
      }
    }
  }
}

/** Published declaration text, including JSDoc. */
function scanFullText(file: string, violations: Violation[]): void {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (BANNED.test(line)) {
      violations.push({
        file: rel(file),
        line: i + 1,
        excerpt: line.trim().slice(0, 120),
      });
    }
  }
}

const violations: Violation[] = [];

// Public connector type declarations: JSDoc is published with the types.
scanFullText(
  join(REPO_ROOT, "packages/connector-sdk/src/reaction-client-types.ts"),
  violations
);

// TypeBox declarations that feed MCP and ClientSDK request/result schemas.
for (const dir of [
  join(REPO_ROOT, "packages/core/src/contracts/tools"),
  join(REPO_ROOT, "packages/server/src/tools"),
  join(REPO_ROOT, "packages/server/src/types"),
]) {
  for (const file of collectTsFiles(dir)) {
    scanTypeBoxSchemas(file, violations);
  }
}

// Tool names/descriptions/titles and SDK discovery text/names/aliases.
for (const file of [
  join(REPO_ROOT, "packages/server/src/tools/registry.ts"),
  join(REPO_ROOT, "packages/server/src/tools/admin/index.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/method-metadata.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-aliases.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-manifest.ts"),
]) {
  scanExposedSyntax(file, violations);
}

// Runtime-callable ClientSDK namespace member names.
const namespacesDir = join(REPO_ROOT, "packages/server/src/sandbox/namespaces");
for (const file of collectTsFiles(namespacesDir)) {
  scanNamespaceMethods(file, violations);
}

const seen = new Set<string>();
const unique = violations.filter((violation) => {
  const key = `${violation.file}:${violation.line}:${violation.excerpt}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (unique.length > 0) {
  console.error(
    `check-exposed-surface-naming: "watcher" is banned on the agent-facing surface ` +
      `(use Behavior / behavior_*). Found ${unique.length} occurrence(s):\n`
  );
  for (const violation of unique) {
    console.error(
      `  ${violation.file}:${violation.line}: ${violation.excerpt}`
    );
  }
  console.error(
    `\nScope: MCP tool schemas/descriptions, ClientSDK discovery and callable ` +
      `method names, and the public reaction client types. Internal engine ` +
      `names outside exposed schema constructs remain allowed.`
  );
  process.exit(1);
}

console.log(
  "check-exposed-surface-naming: clean — no agent-facing 'watcher' on exposed surface."
);

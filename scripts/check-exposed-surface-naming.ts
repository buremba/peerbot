#!/usr/bin/env bun
/**
 * Guard: keep the product name "Behavior" on the agent-facing surface.
 *
 * The word "watcher" remains an internal engine/DB term, but must not appear in:
 *
 *   - MCP tool schemas, names, descriptions, or titles
 *   - ClientSDK discovery metadata, aliases, or namespace method names
 *   - the connector-sdk public reaction contract
 *   - server and web-client response types for shared public tool payloads
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

/** Scan exposed literals and context-appropriate property names, excluding comments. */
function scanSyntaxNode(
  file: string,
  source: ts.SourceFile,
  root: ts.Node,
  violations: Violation[],
  allPropertyNamesAreExposed = false
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
    if (
      text &&
      (allPropertyNamesAreExposed
        ? BANNED.test(text)
        : BANNED_SNAKE_KEY.test(text))
    ) {
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
        scanSyntaxNode(file, source, initializer, violations, true);
      }
    }
  }
}

/**
 * Workspace packages whose types are part of the agent-facing surface. A
 * namespace signature reaches into these directly — `listCatalog(input?:
 * Omit<ListCatalogArgs, "action">)` imports `ListCatalogArgs` from
 * `@lobu/core/...` — so treating "not relative" as "not ours" would skip a
 * live wire contract. Third-party packages stay out of scope: node_modules is
 * not our surface to police.
 */
const WORKSPACE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@lobu/core/", join(REPO_ROOT, "packages/core/src/")],
  ["@lobu/connector-sdk/", join(REPO_ROOT, "packages/connector-sdk/src/")],
  ["@lobu/plugin-api/", join(REPO_ROOT, "packages/plugin-api/src/")],
];

/** Resolve an import specifier to a source file, relative or workspace-aliased. */
function resolveImport(
  fromFile: string,
  specifier: string
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [prefix, root] of WORKSPACE_ALIASES) {
      if (specifier.startsWith(prefix)) {
        base = join(root, specifier.slice(prefix.length));
        break;
      }
    }
  }
  if (!base) return undefined;
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate; try the next.
    }
  }
  return undefined;
}

/**
 * Map every locally-imported type name to the file that defines it AND the name
 * it is declared under there.
 *
 * The distinction matters for aliased imports. `import type { AuthProfileKind
 * as StoredAuthProfileKind }` is referenced locally as `StoredAuthProfileKind`,
 * but the declaring module knows it as `AuthProfileKind` — looking up the local
 * alias in the target file finds nothing and silently gives up, which is
 * exactly how this guard kept passing on a banned member of an imported type.
 */
function importedTypeOrigins(
  file: string,
  source: ts.SourceFile
): Map<string, { file: string; exportedName: string }> {
  const origins = new Map<string, { file: string; exportedName: string }>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      origins.set(element.name.text, {
        file: target,
        // `propertyName` is the name in the source module when aliased.
        exportedName: (element.propertyName ?? element.name).text,
      });
    }
  }
  return origins;
}

/** Find a named type/interface declaration at the top level of a file. */
function findTypeDeclaration(
  source: ts.SourceFile,
  name: string
): ts.Node | undefined {
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === name
    ) {
      return statement;
    }
  }
  return undefined;
}

/**
 * ClientSDK namespace surface: `*Namespace` method names plus every property
 * name and string literal reachable from an exported type in the file — method
 * parameter and return types, nested type literals, exported input/output
 * declarations, and the definitions of types they reference.
 *
 * Recursion matters in two directions, and missing either one has already
 * shipped a false negative past an earlier revision of this guard:
 *
 *   - Depth: an agent-facing key is agent-facing at any depth, so
 *     `{ source: { watcher_id } }` and `method(input: { watcher_id })` are
 *     violations exactly like a top-level member.
 *   - Reference: `profile_kind: AuthProfileKind` puts whatever
 *     `AuthProfileKind` resolves to on the wire. Scanning only the current
 *     file let a banned member of an imported type pass clean, so type
 *     references are followed into their defining module (local paths only —
 *     node_modules is not our surface to police).
 *
 * String literals count here, not just property names: a referenced type is
 * frequently a union of wire values (`"watcher" | "behavior"`), which is
 * exposed vocabulary even though no property carries the word.
 */
function scanNamespaceSurface(file: string, violations: Violation[]): void {
  const seen = new Set<string>();

  function scanFile(currentFile: string, rootNames: string[] | null): void {
    let source: ts.SourceFile;
    try {
      source = parse(currentFile);
    } catch {
      return;
    }
    const imports = importedTypeOrigins(currentFile, source);

    function walk(node: ts.Node): void {
      const name = propertyName(node);
      const text = name && propertyNameText(name);
      if (name && text && BANNED.test(text)) {
        addViolation(violations, currentFile, source, name);
      }

      if (
        (ts.isStringLiteral(node) || isTemplateText(node)) &&
        BANNED.test(node.text)
      ) {
        addViolation(violations, currentFile, source, node);
      }

      // Follow `foo: SomeType` into SomeType's declaration, and `interface X
      // extends Y` into Y's — an inherited member is on the wire exactly like a
      // declared one, and `extends` is an ExpressionWithTypeArguments rather
      // than a TypeReferenceNode, so it needs naming separately.
      const referencedName = ts.isTypeReferenceNode(node)
        ? ts.isIdentifier(node.typeName)
          ? node.typeName.text
          : undefined
        : ts.isExpressionWithTypeArguments(node) &&
            ts.isIdentifier(node.expression)
          ? node.expression.text
          : undefined;
      if (referencedName) {
        const referenced = referencedName;
        const local = findTypeDeclaration(source, referenced);
        if (local) {
          const key = `${currentFile}#${referenced}`;
          if (!seen.has(key)) {
            seen.add(key);
            walk(local);
          }
        } else {
          const origin = imports.get(referenced);
          if (origin) scanFile(origin.file, [origin.exportedName]);
        }
      }

      ts.forEachChild(node, walk);
    }

    if (rootNames) {
      for (const name of rootNames) {
        const key = `${currentFile}#${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const declaration = findTypeDeclaration(source, name);
        if (declaration) walk(declaration);
      }
      return;
    }

    for (const statement of source.statements) {
      const isNamespaceInterface =
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text.endsWith("Namespace");
      const isExportedType =
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        );
      if (isNamespaceInterface || isExportedType) {
        walk(statement);
      }
    }
  }

  scanFile(file, null);
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

// Runtime-callable ClientSDK namespace member names, plus the exported input /
// output types that describe their arguments — `watcher_id` on an exported
// namespace interface is an agent-facing wire key even though it is not a
// method name.
const namespacesDir = join(REPO_ROOT, "packages/server/src/sandbox/namespaces");
for (const file of collectTsFiles(namespacesDir)) {
  scanNamespaceSurface(file, violations);
}

// Plain TypeScript response types are not TypeBox initializers, but they still
// describe public tool payloads. Keep the server projection and the trusted web
// client's wire models under the same vocabulary gate so a generic
// Type.Record result cannot hide a stale key from the schema scan.
for (const file of [
  join(
    REPO_ROOT,
    "packages/server/src/tools/admin/manage_operations/activity-feed.ts"
  ),
  join(REPO_ROOT, "packages/owletto/src/lib/api/activity.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/behaviors.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/content.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/runs.ts"),
]) {
  scanNamespaceSurface(file, violations);
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
      `method names, public response types, and the reaction client types. Internal engine ` +
      `names outside exposed schema constructs remain allowed.`
  );
  process.exit(1);
}

console.log(
  "check-exposed-surface-naming: clean — no agent-facing 'watcher' on exposed surface."
);

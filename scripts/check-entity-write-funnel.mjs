#!/usr/bin/env node
/**
 * Entity-write funnel gate.
 *
 * Production entity-row mutations belong in entity-management.ts. The
 * remaining historical bypasses are pinned below by a whitespace-normalized
 * source fingerprint. The list is intentionally shrinking: removing or
 * changing a bypass makes this gate fail until the allowance is deleted, and
 * adding a bypass fails because it has no allowance.
 *
 * A dynamically selected mutation target is treated conservatively because a
 * helper such as `parentTable("entity")` can hide an entity write from a
 * literal `UPDATE entities` grep.
 *
 * HONEST GAP: this recognizes SQL held in string/template literals. SQL
 * assembled from multiple runtime fragments or expressed through a query
 * builder needs review; the verified origin/main inventory contains neither.
 *
 * Tests, generated trees, and the Owletto submodule are excluded. No database
 * or build is required.
 * Run: `bun scripts/check-entity-write-funnel.mjs`
 * Audit: `bun scripts/check-entity-write-funnel.mjs --print-inventory`
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = process.cwd();
const PACKAGES_ROOT = join(REPO_ROOT, "packages");
const CANONICAL_FUNNEL = "packages/server/src/utils/entity-management.ts";
const SKIPPED_DIRS = new Set([
  "__tests__",
  "dist",
  "generated",
  "node_modules",
  "owletto",
]);

/**
 * Temporary production bypasses, frozen from origin/main on 2026-08-15.
 * Every entry must continue to match exactly one mutation. Delete entries as
 * callers move into the funnel; never add one merely to make CI green.
 */
const ALLOWED_BYPASSES = [
  // Access/resource projection.
  {
    file: "packages/server/src/authz/access-graph.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "1280c3ed0fdded46",
    reason: "resource rename projection",
  },

  // Evaluation projections.
  {
    file: "packages/server/src/runs/eval-cases.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "65e074f820a415f7",
    reason: "judge-model projection",
  },
  {
    file: "packages/server/src/runs/eval-cases.ts",
    operation: "insert",
    dynamic: false,
    fingerprint: "5851d53b1d3777ee",
    reason: "eval-case entity projection",
  },
  {
    file: "packages/server/src/runs/eval-scores.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "b53e657432cbb0da",
    reason: "locked rolling score projection",
  },
  {
    file: "packages/server/src/runs/eval-suite.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "cdb38e54da5ece98",
    reason: "suite-trials projection",
  },

  // Connector identity attribution and provisional cleanup.
  {
    file: "packages/server/src/utils/entity-link-upsert.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "2861920694ec0b57",
    reason: "atomic connector alias union",
  },
  {
    file: "packages/server/src/utils/entity-link-upsert.ts",
    operation: "insert",
    dynamic: false,
    fingerprint: "53a1d02d941dbf12",
    reason: "connector-attributed entity create",
  },
  {
    file: "packages/server/src/utils/entity-link-upsert.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "c3df275b1acf2aa4",
    reason: "connector trait projection",
  },
  {
    file: "packages/server/src/utils/entity-link-upsert.ts",
    operation: "delete",
    dynamic: false,
    fingerprint: "28b38f1cbc483794",
    count: 2,
    reason: "lost identity or mint race cleanup",
  },

  // Merge and unmerge compound transaction. Never add runMutationGate here.
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "e77cba72098c5fbf",
    reason: "merge winner state",
  },
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "d6bda7fd7951c50a",
    reason: "merge flattened redirects",
  },
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "57edeaf7d0e925bb",
    reason: "merge loser tombstone",
  },
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "7629cfa8fba9cac8",
    reason: "unmerge redirect restore",
  },
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "454f4072c996a016",
    reason: "unmerge winner restore",
  },
  {
    file: "packages/server/src/utils/entity-merge.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "45cc1d85cddd8374",
    reason: "unmerge loser revive",
  },

  // Member lifecycle projections.
  {
    file: "packages/server/src/utils/member-entity.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "eda8f87e28c0f602",
    reason: "member status projection",
  },
  {
    file: "packages/server/src/utils/member-entity.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "1d4a7505da557ec9",
    reason: "member access projection",
  },
  {
    file: "packages/server/src/utils/member-entity.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "ea1d914a77903682",
    reason: "member soft delete",
  },

  // Automation classifier configuration projection.
  {
    file: "packages/server/src/automations/classifier-extraction.ts",
    operation: "update",
    dynamic: false,
    fingerprint: "985025144395f419",
    reason: "enabled-classifier projection",
  },

  // Per-entity view-template pointer, hidden behind parentTable(resourceType).
  {
    file: "packages/server/src/tools/admin/manage_view_templates.ts",
    operation: "update",
    dynamic: true,
    fingerprint: "6c2d50be50c02a93",
    count: 2,
    reason: "set or rollback default entity view template",
  },
  {
    file: "packages/server/src/tools/admin/manage_view_templates.ts",
    operation: "update",
    dynamic: true,
    fingerprint: "e18b52b5f5dfdd8a",
    reason: "clear default entity view template",
  },
];

const STATIC_IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const ENTITY_TARGET = String.raw`(?:(?:${STATIC_IDENTIFIER}\s*\.\s*)?"?entities"?)`;
const DYNAMIC_TABLE = String.raw`(?:"\$\{[^}]+\}"|\$\{[^}]+\})`;
const DYNAMIC_TARGET = String.raw`(?:(?:${STATIC_IDENTIFIER}|${DYNAMIC_TABLE})\s*\.\s*)*${DYNAMIC_TABLE}(?:\s*\.\s*(?:${STATIC_IDENTIFIER}|${DYNAMIC_TABLE}))*`;
const MUTATION_PATTERNS = [
  {
    operation: "insert",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bINSERT\s+INTO\s+${ENTITY_TARGET}(?:\s+AS\s+${STATIC_IDENTIFIER})?\s*(?:\(|\$\{|DEFAULT\b|OVERRIDING\b|VALUES\b|SELECT\b)`,
      "gi"
    ),
  },
  {
    operation: "update",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bUPDATE(?:\s+ONLY)?\s+${ENTITY_TARGET}(?:\s*\*)?(?:\s+(?:AS\s+)?${STATIC_IDENTIFIER})?\s+SET\b`,
      "gi"
    ),
  },
  {
    operation: "delete",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bDELETE\s+FROM(?:\s+ONLY)?\s+${ENTITY_TARGET}(?![A-Za-z0-9_])`,
      "gi"
    ),
  },
  {
    operation: "insert",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bINSERT\s+INTO\s+${DYNAMIC_TARGET}(?:\s+AS\s+${STATIC_IDENTIFIER})?\s*(?:\(|\$\{|DEFAULT\b|OVERRIDING\b|VALUES\b|SELECT\b)`,
      "gi"
    ),
  },
  {
    operation: "update",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bUPDATE(?:\s+ONLY)?\s+${DYNAMIC_TARGET}(?:\s*\*)?(?:\s+(?:AS\s+)?${STATIC_IDENTIFIER})?\s+SET\b`,
      "gi"
    ),
  },
  {
    operation: "delete",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bDELETE\s+FROM(?:\s+ONLY)?\s+${DYNAMIC_TARGET}`,
      "gi"
    ),
  },
  {
    operation: "truncate",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bTRUNCATE(?:\s+TABLE)?\s+(?:[^;]*?,\s*)?(?:ONLY\s+)?${ENTITY_TARGET}(?![A-Za-z0-9_])`,
      "gi"
    ),
  },
  {
    operation: "truncate",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bTRUNCATE(?:\s+TABLE)?\s+(?:[^;]*?,\s*)?(?:ONLY\s+)?${DYNAMIC_TARGET}`,
      "gi"
    ),
  },
  {
    operation: "merge",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bMERGE\s+INTO(?:\s+ONLY)?\s+${ENTITY_TARGET}(?![A-Za-z0-9_])`,
      "gi"
    ),
  },
  {
    operation: "merge",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bMERGE\s+INTO(?:\s+ONLY)?\s+${DYNAMIC_TARGET}`,
      "gi"
    ),
  },
  {
    operation: "copy",
    dynamic: false,
    regex: new RegExp(
      String.raw`\bCOPY\s+${ENTITY_TARGET}(?![A-Za-z0-9_])(?:\s*\([^)]*\))?\s+FROM\b`,
      "gi"
    ),
  },
  {
    operation: "copy",
    dynamic: true,
    regex: new RegExp(
      String.raw`\bCOPY\s+${DYNAMIC_TARGET}(?:\s*\([^)]*\))?\s+FROM\b`,
      "gi"
    ),
  },
];

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...collectSourceFiles(join(dir, entry.name)));
      }
      continue;
    }
    if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".spec.tsx") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function literalSources(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const source = node.getText(sourceFile);
    const unquoted = source.length >= 2 ? source.slice(1, -1) : "";
    return { fingerprintSource: unquoted, scanSource: unquoted };
  }
  if (ts.isTemplateExpression(node)) {
    const source = node.getText(sourceFile);
    const fingerprintSource = source.length >= 2 ? source.slice(1, -1) : "";
    let scanSource = fingerprintSource;
    const innerStart = node.getStart(sourceFile) + 1;
    for (const span of [...node.templateSpans].reverse()) {
      // The AST already knows where each interpolation ends, even when its
      // expression contains nested object blocks or nested template literals.
      // Mask its braces while preserving every character and newline, so the
      // SQL regex sees one placeholder and reported source lines remain exact.
      const start = span.expression.getFullStart() - innerStart;
      const end = span.literal.getStart(sourceFile) - innerStart;
      const masked = scanSource.slice(start, end).replace(/[^\r\n]/g, "e");
      scanSource = scanSource.slice(0, start) + masked + scanSource.slice(end);
    }
    return { fingerprintSource, scanSource };
  }
  return null;
}

function normalizedFingerprint(source) {
  const normalized = source.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function scanLiteral(
  scanSource,
  fingerprintSource,
  node,
  sourceFile,
  file,
  mutations
) {
  for (const { regex, dynamic, operation } of MUTATION_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of scanSource.matchAll(regex)) {
      const offset = node.getStart(sourceFile) + 1 + (match.index ?? 0);
      const { line } = sourceFile.getLineAndCharacterOfPosition(offset);
      mutations.push({
        file,
        line: line + 1,
        operation,
        dynamic,
        fingerprint: normalizedFingerprint(fingerprintSource),
      });
    }
  }
}

function scanFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const file = relative(REPO_ROOT, filePath);
  const mutations = [];

  function visit(node) {
    const literal = literalSources(node, sourceFile);
    if (literal !== null) {
      scanLiteral(
        literal.scanSource,
        literal.fingerprintSource,
        node,
        sourceFile,
        file,
        mutations
      );
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return mutations;
}

function allowanceKey(item) {
  return `${item.file}|${item.operation}|${item.dynamic ? "dynamic" : "direct"}|${item.fingerprint}`;
}

if (!existsSync(PACKAGES_ROOT)) {
  console.error(`✗ expected ${PACKAGES_ROOT} to exist`);
  process.exit(1);
}
if (!existsSync(join(REPO_ROOT, CANONICAL_FUNNEL))) {
  console.error(
    `✗ entity-write funnel gate: canonical funnel ${CANONICAL_FUNNEL} is missing`
  );
  process.exit(1);
}

const files = collectSourceFiles(PACKAGES_ROOT);
if (files.length === 0) {
  console.error(
    "✗ entity-write funnel gate scanned ZERO runtime package source files; failing closed"
  );
  process.exit(1);
}

const mutations = files.flatMap(scanFile);
const canonicalMutations = mutations.filter(
  (item) => item.file === CANONICAL_FUNNEL
);
if (canonicalMutations.length === 0) {
  console.error(
    `✗ entity-write funnel gate found zero writes in ${CANONICAL_FUNNEL}; failing closed`
  );
  process.exit(1);
}
const bypasses = mutations.filter((item) => item.file !== CANONICAL_FUNNEL);

if (process.argv.includes("--print-inventory")) {
  for (const item of bypasses) {
    console.log(
      JSON.stringify({
        file: item.file,
        line: item.line,
        operation: item.operation,
        dynamic: item.dynamic,
        fingerprint: item.fingerprint,
      })
    );
  }
  process.exit(0);
}

const remainingAllowances = new Map();
for (const allowance of ALLOWED_BYPASSES) {
  const key = allowanceKey(allowance);
  const count = allowance.count ?? 1;
  remainingAllowances.set(key, (remainingAllowances.get(key) ?? 0) + count);
}

const violations = [];
for (const bypass of bypasses) {
  const key = allowanceKey(bypass);
  const remaining = remainingAllowances.get(key) ?? 0;
  if (remaining > 0) {
    remainingAllowances.set(key, remaining - 1);
  } else {
    violations.push(bypass);
  }
}

const staleAllowances = [];
for (const allowance of ALLOWED_BYPASSES) {
  const key = allowanceKey(allowance);
  const remaining = remainingAllowances.get(key) ?? 0;
  if (remaining > 0) {
    staleAllowances.push({ ...allowance, remaining });
    remainingAllowances.set(key, 0);
  }
}

const staleAllowanceCount = staleAllowances.reduce(
  (count, allowance) => count + allowance.remaining,
  0
);

if (violations.length > 0 || staleAllowances.length > 0) {
  if (violations.length > 0) {
    console.error(
      `\n✗ entity-write funnel gate found ${violations.length} unapproved bypass(es):\n`
    );
    for (const violation of violations) {
      const target = violation.dynamic
        ? "dynamic mutation target"
        : `direct entity ${violation.operation}`;
      console.error(`  - ${violation.file}:${violation.line} [${target}]`);
    }
  }
  if (staleAllowances.length > 0) {
    console.error(
      `\n✗ entity-write funnel gate found ${staleAllowanceCount} stale allowance(s):\n`
    );
    for (const allowance of staleAllowances) {
      const count = allowance.remaining > 1 ? ` x${allowance.remaining}` : "";
      console.error(`  - ${allowance.file}${count} [${allowance.reason}]`);
    }
  }
  const remediation = [];
  if (violations.some((violation) => !violation.dynamic)) {
    remediation.push(
      "Route production entity-row mutations through " +
        `${CANONICAL_FUNNEL}; do not add an allowance for new code.`
    );
  }
  if (violations.some((violation) => violation.dynamic)) {
    remediation.push(
      "A dynamically named table cannot be proven non-entity; use a literal " +
        "table name or pin the statement in ALLOWED_BYPASSES with a reason."
    );
  }
  if (staleAllowances.length > 0) {
    remediation.push("Remove an allowance when its bypass is migrated.");
  }
  console.error(`\n${remediation.join("\n")}\n`);
  process.exit(1);
}

console.log(
  `✓ entity-write funnel gate: ${files.length} runtime package source files scanned; ` +
    `${bypasses.length} pinned bypasses, zero new bypasses`
);

/**
 * Decides whether a pending migration lets the old replicas keep serving while
 * it is applied.
 *
 * The chart's pre-upgrade hook (charts/lobu/files/migrate-upgrade.sh) scales the
 * app to zero before migrating so no old pod can observe a new schema. That
 * costs a full pod-restart of downtime, which the ingress answers with 503. The
 * expand half of an expand/contract pair does not need it: the old code already
 * runs against the post-migration schema.
 *
 * Only the migration's author can assert that, because it is a claim about the
 * application rather than about the DDL -- so the assertion is explicit, and
 * this module verifies it is at least not self-contradictory.
 */

/** The author's assertion that the pre-migration code survives this change. */
export const NO_QUIESCE_MARKER = /^--[ \t]*lobu:no-quiesce\b/m;

/**
 * Shapes that cannot be backward-compatible whatever the author believes, so a
 * marker on top of one is a mistake rather than an assertion. Matching any of
 * them forfeits the fast path; it never grants it.
 */
const INCOMPATIBLE_DDL = [
  [
    /\bDROP\s+(TABLE|COLUMN|VIEW|TYPE|SEQUENCE|SCHEMA|CONSTRAINT)\b/i,
    "drops an object the old code may still reference",
  ],
  [
    /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i,
    "renames an object the old code may still reference",
  ],
  [
    /\bSET\s+NOT\s+NULL\b/i,
    "adds NOT NULL, which the old code's inserts may violate",
  ],
  [/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i, "changes a column type"],
  [
    /\bADD\s+(CONSTRAINT|CHECK)\b/i,
    "adds a constraint the old code's writes may violate",
  ],
];

/** Strip comments so prose cannot be mistaken for DDL. */
export function stripSqlComments(statement) {
  return statement.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The reason this statement forfeits the fast path, or null if it is safe. */
export function findIncompatibleDdl(statement) {
  const bare = stripSqlComments(statement);
  for (const [pattern, reason] of INCOMPATIBLE_DDL) {
    if (pattern.test(bare)) return reason;
  }
  // ADD COLUMN ... NOT NULL is only safe when a DEFAULT backfills the old
  // code's inserts; without one every pre-migration INSERT starts failing.
  if (
    /\bADD\s+COLUMN\b/i.test(bare) &&
    /\bNOT\s+NULL\b/i.test(bare) &&
    !/\bDEFAULT\b/i.test(bare)
  ) {
    return "adds a NOT NULL column with no DEFAULT";
  }
  return null;
}

/**
 * Classify one migration.
 *
 * @param file        migration filename, for the reported reason
 * @param content     the whole file, searched for the marker
 * @param upStatements the migrate:up section, already split into statements.
 *                     The migrate:down section must NOT be included -- a down
 *                     section legitimately drops what its up section added.
 */
export function classifyMigrationSource(file, content, upStatements) {
  if (!NO_QUIESCE_MARKER.test(content)) {
    return { file, compatible: false, reason: "not marked -- lobu:no-quiesce" };
  }
  for (const statement of upStatements) {
    const reason = findIncompatibleDdl(statement);
    if (reason) {
      return {
        file,
        compatible: false,
        reason: `marked -- lobu:no-quiesce but ${reason}`,
      };
    }
  }
  return { file, compatible: true, reason: "marked backward-compatible" };
}

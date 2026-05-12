import chalk from "chalk";
import type { DiffPlan, DiffRow } from "./diff.js";

const VERB_PREFIX = {
  create: chalk.green("+"),
  update: chalk.yellow("~"),
  noop: chalk.dim("="),
  drift: chalk.cyan("?"),
} as const;

const KIND_LABEL: Record<DiffRow["kind"], string> = {
  agent: "agent",
  settings: "settings",
  platform: "platform",
  "entity-type": "entity-type",
  "relationship-type": "relationship-type",
  watcher: "watcher",
  "connector-definition": "connector-definition",
  "auth-profile": "auth-profile",
  connection: "connection",
  feed: "feed",
};

function fieldsList(fields: string[] | undefined): string {
  if (!fields?.length) return "";
  return chalk.dim(` (${fields.join(", ")})`);
}

function rowId(row: DiffRow): string {
  if (row.kind === "platform") return `${row.agentId}/${row.id}`;
  if (
    row.kind === "connector-definition" &&
    row.desired?.key &&
    row.desired.sourcePath
  ) {
    return `${row.desired.key} (from ${row.desired.sourceFile})`;
  }
  if (row.kind === "connector-definition" && row.desired) {
    return row.desired.sourceUrl
      ? `${row.desired.sourceFile} (${row.desired.sourceUrl})`
      : row.desired.sourceFile;
  }
  return row.id;
}

function renderRow(row: DiffRow): string[] {
  const prefix = VERB_PREFIX[row.verb];
  const label = chalk.bold(KIND_LABEL[row.kind]);
  const id = rowId(row);
  const lines: string[] = [];

  switch (row.verb) {
    case "create":
      lines.push(`  ${prefix} ${label} ${id}`);
      if (
        row.kind === "connector-definition" &&
        row.installedRemotely &&
        row.desired?.key
      ) {
        lines.push(
          `      ${chalk.dim("(already installed — apply re-pushes source; no-op if unchanged)")}`
        );
      }
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth — complete it via the connect URL printed after apply`
        );
      }
      break;
    case "update":
      lines.push(
        `  ${prefix} ${label} ${id}${fieldsList("changedFields" in row ? row.changedFields : undefined)}`
      );
      if (row.kind === "platform" && row.willRestart) {
        lines.push(
          `      ${chalk.yellow("⚠")} will restart platform — in-flight messages may drop`
        );
      }
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth — complete it via the connect URL printed after apply`
        );
      }
      break;
    case "noop":
      lines.push(`  ${prefix} ${label} ${id}`);
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth still pending — complete it via the connect URL printed after apply`
        );
      }
      break;
    case "drift":
      lines.push(
        `  ${prefix} ${label} ${id} ${chalk.cyan("(drift — ignored in v1, not deleted)")}`
      );
      break;
  }

  return lines;
}

/** Emit the plan summary block — what `--dry-run` and the prompt-confirm phase show. */
export function renderPlan(plan: DiffPlan): string {
  const lines: string[] = [];
  lines.push(chalk.bold("\nPlan:"));

  // Group rows by kind so the output order is deterministic and readable.
  const order: DiffRow["kind"][] = [
    "agent",
    "settings",
    "platform",
    "entity-type",
    "relationship-type",
    "watcher",
    "connector-definition",
    "auth-profile",
    "connection",
    "feed",
  ];
  for (const kind of order) {
    const rowsForKind = plan.rows.filter((row) => row.kind === kind);
    if (rowsForKind.length === 0) continue;
    lines.push("");
    lines.push(chalk.bold(`  ${KIND_LABEL[kind]}s:`));
    for (const row of rowsForKind) {
      lines.push(...renderRow(row));
    }
  }

  const notes = plan.notes ?? [];
  if (notes.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Notes:"));
    for (const note of notes) {
      lines.push(`  ${chalk.cyan("•")} ${note}`);
    }
  }

  lines.push("");
  lines.push(renderSummary(plan));
  return lines.join("\n");
}

/** Post-apply punch-list: pending interactive auth + informational notes. */
export function renderPostApplyPunchList(items: {
  pendingAuth: Array<{ slug: string; kind: string; connectUrl?: string }>;
  notes: string[];
}): string | null {
  if (items.pendingAuth.length === 0 && items.notes.length === 0) return null;
  const lines: string[] = [chalk.bold("\nNext steps:")];
  for (const item of items.pendingAuth) {
    if (item.connectUrl) {
      lines.push(
        `  ${chalk.yellow("→")} auth profile ${chalk.bold(item.slug)} (${item.kind}) needs authorization: ${chalk.underline(item.connectUrl)}`
      );
    } else {
      lines.push(
        `  ${chalk.yellow("→")} auth profile ${chalk.bold(item.slug)} (${item.kind}) needs a session — set it up in the connections UI`
      );
    }
  }
  for (const note of items.notes) {
    lines.push(`  ${chalk.cyan("•")} ${note}`);
  }
  return lines.join("\n");
}

export function renderSummary(plan: DiffPlan): string {
  const { create, update, noop, drift } = plan.counts;
  return chalk.bold(
    `Summary: ${chalk.green(`${create} create`)}, ${chalk.yellow(`${update} update`)}, ${chalk.dim(`${noop} noop`)}, ${chalk.cyan(`${drift} drift`)}`
  );
}

/** Apply-time progress line. Mirrors the same prefix as the plan rows. */
export function renderProgress(
  verb: DiffRow["verb"],
  kind: DiffRow["kind"],
  id: string,
  detail?: string
): string {
  const prefix = VERB_PREFIX[verb];
  const label = chalk.bold(KIND_LABEL[kind]);
  const tail = detail ? chalk.dim(` ${detail}`) : "";
  return `  ${prefix} ${label} ${id}${tail}`;
}

/** Required-secrets-missing block. */
export function renderMissingSecrets(missing: string[]): string {
  const lines = [
    chalk.red(
      `\n  Missing ${missing.length} required secret${missing.length === 1 ? "" : "s"}:`
    ),
  ];
  for (const name of missing) lines.push(chalk.red(`    - $${name}`));
  lines.push(
    chalk.dim(
      "\n  These env vars are referenced in lobu.toml but are not set in the current environment."
    )
  );
  lines.push(
    chalk.dim(
      "  Set them locally (e.g. via .env) or via your deployment's secret manager and retry."
    )
  );
  return lines.join("\n");
}

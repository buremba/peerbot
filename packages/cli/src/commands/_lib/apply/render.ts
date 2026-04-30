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
  connection: "connection",
  "entity-type": "entity-type",
  "relationship-type": "relationship-type",
};

function fieldsList(fields: string[] | undefined): string {
  if (!fields?.length) return "";
  return chalk.dim(` (${fields.join(", ")})`);
}

function renderRow(row: DiffRow): string[] {
  const prefix = VERB_PREFIX[row.verb];
  const label = chalk.bold(KIND_LABEL[row.kind]);
  const id = row.kind === "connection" ? `${row.agentId}/${row.id}` : row.id;
  const lines: string[] = [];

  switch (row.verb) {
    case "create":
      lines.push(`  ${prefix} ${label} ${id}`);
      break;
    case "update":
      lines.push(`  ${prefix} ${label} ${id}${fieldsList(row.changedFields)}`);
      if (row.kind === "connection" && row.willRestart) {
        lines.push(
          `      ${chalk.yellow("⚠")} will restart connection — in-flight messages may drop`
        );
      }
      break;
    case "noop":
      lines.push(`  ${prefix} ${label} ${id}`);
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
    "connection",
    "entity-type",
    "relationship-type",
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

  lines.push("");
  lines.push(renderSummary(plan));
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

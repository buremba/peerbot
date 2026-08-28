import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import { resolveApiClient } from "../internal/api-client.js";
import { printJson } from "../internal/output.js";
import { ValidationError } from "./memory/_lib/errors.js";

interface IdentityRekeyOptions {
  context?: string;
  org?: string;
  url?: string;
  mapping: string;
  apply?: boolean;
  json?: boolean;
}

interface IdentityRekeyReport {
  namespace: string;
  targetScope: "organization" | "tenant";
  targetScopeKeyPath: string | null;
  connectorKeys: string[];
  liveIdentityCount: number;
  changes: Array<{
    id: string;
    identifier: string;
    fromScopeKey: string | null;
    toScopeKey: string | null;
  }>;
  applied: boolean;
}

async function readMapping(path: string): Promise<Record<string, unknown>> {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new ValidationError(
      `Could not read identity mapping ${absolute}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(
      "Identity mapping must be a JSON object keyed by entity_identity_id."
    );
  }
  return parsed as Record<string, unknown>;
}

function printReport(report: IdentityRekeyReport): void {
  console.log(chalk.bold(`\n  Identity re-key plan for ${report.namespace}`));
  console.log(`  Live identities: ${report.liveIdentityCount}`);
  console.log(
    `  Target shape: ${report.targetScope}` +
      (report.targetScopeKeyPath ? ` (${report.targetScopeKeyPath})` : "")
  );
  console.log(`  Connectors: ${report.connectorKeys.join(", ")}`);
  for (const change of report.changes) {
    console.log(
      chalk.dim(
        `  #${change.id} (${change.identifier}): ${change.fromScopeKey ?? "<organization>"} → ${change.toScopeKey ?? "<organization>"}`
      )
    );
  }
}

export async function identitiesRekeyCommand(
  namespace: string,
  options: IdentityRekeyOptions
): Promise<void> {
  const mapping = await readMapping(options.mapping);
  const { client, orgSlug } = await resolveApiClient({
    context: options.context,
    org: options.org,
    apiUrl: options.url,
  });
  const path = `/api/${orgSlug}/identities/rekey`;
  const dryRun = await client.post<IdentityRekeyReport>(path, {
    namespace,
    mapping,
    apply: false,
  });
  if (!options.json) printReport(dryRun);
  if (!options.apply) {
    if (options.json) printJson(dryRun);
    else
      console.log(
        chalk.yellow(
          "\n  Dry run only. Re-run with --apply to perform this re-key.\n"
        )
      );
    return;
  }
  const applied = await client.post<IdentityRekeyReport>(path, {
    namespace,
    mapping,
    apply: true,
  });
  if (options.json) printJson(applied);
  else
    console.log(
      chalk.green(
        `\n  Re-keyed ${applied.liveIdentityCount} identities atomically.\n`
      )
    );
}

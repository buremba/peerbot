/**
 * Sandbox environment commands over `/api/<org>/environments` — the only
 * surface for provider-backed runtimes (environments are not part of
 * `lobu apply`, and deletes are deliberately imperative + `--yes`-gated so a
 * config edit can never drop a credential).
 */

import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import type { CloudCommandOptions } from "./_lib/cloud-options.js";
import { parseKeyValueEntries } from "./_lib/secret-value.js";

interface EnvironmentRow {
  id: string;
  name: string;
  providerKind: string;
  connected?: boolean;
  details?: Record<string, string>;
}

interface EnvironmentListResponse {
  builtin?: { id: string; kind: string; availableInCloud?: boolean };
  environments: EnvironmentRow[];
  availableProviders: string[];
}

export async function environmentListCommand(
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const body = await client.get<EnvironmentListResponse>(
    `/api/${orgSlug}/environments`
  );

  if (options.json) {
    printJson(body);
    return;
  }

  console.log(chalk.bold(`\n  Environments in ${orgSlug}`));
  if (body.builtin) {
    console.log(
      `  ${chalk.green("●")} ${chalk.bold("builtin")} ${chalk.dim("(local runtime)")}`
    );
  }
  for (const env of body.environments) {
    const connected = env.connected
      ? chalk.green("connected")
      : chalk.yellow("no credential");
    const details =
      env.details && Object.keys(env.details).length > 0
        ? chalk.dim(
            `  ${Object.entries(env.details)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}`
          )
        : "";
    console.log(
      `  ${chalk.green("●")} ${chalk.bold(env.name)} ${chalk.dim(env.providerKind)}  ${connected}${details}  ${chalk.dim(env.id)}`
    );
  }
  if (body.environments.length === 0) {
    console.log(chalk.dim("  No provider-backed environments."));
  }
  if (body.availableProviders.length > 0) {
    console.log(
      chalk.dim(
        `\n  Available providers: ${body.availableProviders.join(", ")}\n`
      )
    );
  } else {
    console.log();
  }
}

export async function environmentCreateCommand(
  name: string,
  options: CloudCommandOptions & {
    provider: string;
    credential?: string[];
  }
): Promise<void> {
  const credential = options.credential?.length
    ? parseKeyValueEntries(options.credential, "--credential")
    : undefined;

  const { client, orgSlug } = await resolveApiClient(options);
  const { environment } = await client.post<{ environment: EnvironmentRow }>(
    `/api/${orgSlug}/environments`,
    {
      name,
      provider_kind: options.provider,
      ...(credential ? { credential } : {}),
    }
  );

  if (options.json) {
    printJson(environment);
    return;
  }
  const credentialNote = credential
    ? ""
    : chalk.dim(
        `  Add its credential with: lobu environment set-credential ${environment.id} --credential 'key=$VAR'\n`
      );
  console.log(
    chalk.green(
      `\n  Created environment ${name} (${environment.id}) in ${orgSlug}.\n`
    ) + credentialNote
  );
}

export async function environmentSetCredentialCommand(
  id: string,
  options: CloudCommandOptions & { credential: string[] }
): Promise<void> {
  if (!options.credential?.length) {
    console.error(chalk.red("\n  Pass at least one --credential key=value.\n"));
    process.exit(1);
  }
  const credential = parseKeyValueEntries(options.credential, "--credential");

  const { client, orgSlug } = await resolveApiClient(options);
  await client.request(
    "PUT",
    `/api/${orgSlug}/environments/${encodeURIComponent(id)}/credential`,
    { credential }
  );
  console.log(chalk.green(`\n  Updated credential for environment ${id}.\n`));
}

export async function environmentDeleteCommand(
  id: string,
  options: CloudCommandOptions & { yes?: boolean } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to delete without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  await client.delete(`/api/${orgSlug}/environments/${encodeURIComponent(id)}`);
  console.log(chalk.green(`\n  Deleted environment ${id}.\n`));
}

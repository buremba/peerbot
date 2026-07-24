/**
 * Sandbox commands over `/api/<org>/sandboxes` — the only surface for
 * provider-backed runtimes (sandboxes are not part of `lobu apply`, and deletes
 * are deliberately imperative + `--yes`-gated so a config edit can never drop a
 * credential).
 */

import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import type { CloudCommandOptions } from "./_lib/cloud-options.js";
import { parseKeyValueEntries } from "./_lib/secret-value.js";

interface SandboxRow {
  id: string;
  name: string;
  providerKind: string;
  connected?: boolean;
  details?: Record<string, string>;
}

interface SandboxListResponse {
  builtin?: { id: string; kind: string; availableInCloud?: boolean };
  sandboxes: SandboxRow[];
  availableProviders: string[];
}

export async function sandboxListCommand(
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const body = await client.get<SandboxListResponse>(
    `/api/${orgSlug}/sandboxes`
  );

  if (options.json) {
    printJson(body);
    return;
  }

  console.log(chalk.bold(`\n  Sandboxes in ${orgSlug}`));
  if (body.builtin) {
    console.log(
      `  ${chalk.green("●")} ${chalk.bold("builtin")} ${chalk.dim("(local runtime)")}`
    );
  }
  for (const sandbox of body.sandboxes) {
    const connected = sandbox.connected
      ? chalk.green("connected")
      : chalk.yellow("no credential");
    const details =
      sandbox.details && Object.keys(sandbox.details).length > 0
        ? chalk.dim(
            `  ${Object.entries(sandbox.details)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}`
          )
        : "";
    console.log(
      `  ${chalk.green("●")} ${chalk.bold(sandbox.name)} ${chalk.dim(sandbox.providerKind)}  ${connected}${details}  ${chalk.dim(sandbox.id)}`
    );
  }
  if (body.sandboxes.length === 0) {
    console.log(chalk.dim("  No provider-backed sandboxes."));
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

export async function sandboxCreateCommand(
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
  const { sandbox } = await client.post<{ sandbox: SandboxRow }>(
    `/api/${orgSlug}/sandboxes`,
    {
      name,
      provider_kind: options.provider,
      ...(credential ? { credential } : {}),
    }
  );

  if (options.json) {
    printJson(sandbox);
    return;
  }
  const credentialNote = credential
    ? ""
    : chalk.dim(
        `  Add its credential with: lobu sandbox set-credential ${sandbox.id} --credential 'key=$VAR'\n`
      );
  console.log(
    chalk.green(
      `\n  Created sandbox ${name} (${sandbox.id}) in ${orgSlug}.\n`
    ) + credentialNote
  );
}

export async function sandboxSetCredentialCommand(
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
    `/api/${orgSlug}/sandboxes/${encodeURIComponent(id)}/credential`,
    { credential }
  );
  console.log(chalk.green(`\n  Updated credential for sandbox ${id}.\n`));
}

export async function sandboxDeleteCommand(
  id: string,
  options: CloudCommandOptions & { yes?: boolean } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to delete without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  await client.delete(`/api/${orgSlug}/sandboxes/${encodeURIComponent(id)}`);
  console.log(chalk.green(`\n  Deleted sandbox ${id}.\n`));
}

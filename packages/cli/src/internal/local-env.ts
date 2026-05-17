import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function setLocalEnvValue(
  cwd: string,
  key: string,
  value: string
): Promise<void> {
  const envPath = join(cwd, ".env");
  let content = "";
  try {
    content = await readFile(envPath, "utf-8");
  } catch {
    content = "";
  }

  const serialized = `${key}=${formatEnvValue(value)}`;
  const trimmed = content.trimEnd();
  const lines = trimmed ? trimmed.split("\n") : [];
  let found = false;
  const updated = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return serialized;
    }
    return line;
  });

  if (!found) updated.push(serialized);
  // `.env` holds provider API keys, bot tokens, OAuth refresh tokens —
  // anything `lobu init` / `lobu memory ...` writes back. Default umask
  // (022) would leave the file world-readable; clamp to 0600 so other
  // local accounts can't lift secrets off a shared host.
  await writeFile(envPath, updated.join("\n"), { mode: 0o600 });
  // `mode:` only applies on file creation. If `.env` already existed
  // (e.g. user created it before running `lobu init`), tighten now.
  await chmod(envPath, 0o600).catch(() => undefined);
}

function formatEnvValue(value: string): string {
  if (!/[\s#"'\\]/.test(value)) return value;
  return JSON.stringify(value);
}

import chalk from "chalk";
import {
  clearCredentials,
  loadCredentials,
  resolveContext,
} from "@lobu/cli-core";

export async function logoutCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const creds = await loadCredentials(target.name);

  // Revoke session server-side if we have a refresh token
  if (creds?.refreshToken) {
    try {
      await fetch(`${target.apiUrl}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: creds.refreshToken }),
      });
    } catch {
      // Best-effort — clear local creds regardless
    }
  }

  await clearCredentials(target.name);
  console.log(chalk.dim(`\n  Logged out of ${target.name}.\n`));
}

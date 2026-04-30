import chalk from "chalk";
import {
  clearCredentials,
  loadCredentials,
  resolveContext,
} from "../internal/index.js";
import { revokeToken } from "../internal/oauth.js";

export async function logoutCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const creds = await loadCredentials(target.name);

  // Best-effort RFC 7009 revocation. Local state is cleared either way so a
  // failed remote revoke (network down, issuer offline) doesn't strand the
  // user logged in locally.
  if (creds?.oauth?.revocationEndpoint && creds.oauth.clientId) {
    const client = {
      clientId: creds.oauth.clientId,
      clientSecret: creds.oauth.clientSecret,
    };
    if (creds.refreshToken) {
      await revokeToken(
        creds.oauth.revocationEndpoint,
        client,
        creds.refreshToken,
        "refresh_token"
      );
    }
    await revokeToken(
      creds.oauth.revocationEndpoint,
      client,
      creds.accessToken,
      "access_token"
    );
  }

  await clearCredentials(target.name);
  console.log(chalk.dim(`\n  Logged out of ${target.name}.\n`));
}

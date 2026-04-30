import chalk from "chalk";
import open from "open";
import ora from "ora";
import {
  type Credentials,
  type OAuthClientInfo,
  clearCredentials,
  loadCredentials,
  resolveContext,
  saveCredentials,
} from "../internal/index.js";
import {
  bumpInterval,
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorization,
  discoverOAuth,
  fetchUserInfo,
  type OAuthDiscovery,
  OAuthError,
  pollDeviceToken,
  type RegisteredClient,
  registerClient,
  revokeToken,
  startDeviceAuthorization,
} from "../internal/oauth.js";

interface LoginOptions {
  token?: string;
  context?: string;
  force?: boolean;
  /** Forwarded to RFC 7591 dynamic client registration as `software_version`. */
  cliVersion?: string;
}

/**
 * `lobu login` runs the OAuth 2.0 device-code grant against the issuer
 * advertised at `<apiUrl-origin>/.well-known/oauth-authorization-server`.
 * `--token <pat>` skips OAuth entirely for CI/CD.
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  const target = await resolveContext(options.context);

  const existing = await loadCredentials(target.name);
  if (existing && !options.force) {
    console.log(
      chalk.dim(
        `\n  Already logged in to ${target.name} as ${existing.email ?? existing.name ?? "user"}.`
      )
    );
    console.log(
      chalk.dim(
        "  Run `lobu logout` first, or use `--force` to re-authenticate.\n"
      )
    );
    return;
  }

  if (existing && options.force) {
    await revokeExisting(existing);
    await clearCredentials(target.name);
  }

  if (options.token) {
    await loginWithToken(target, options.token);
    return;
  }

  let discovery: OAuthDiscovery;
  try {
    discovery = await discoverOAuth(target.apiUrl);
  } catch (err) {
    const message =
      err instanceof OAuthError ? err.message : String((err as Error).message);
    console.log(chalk.red(`\n  ${message}`));
    console.log(
      chalk.dim(
        "  Confirm the context URL is correct: `lobu context current`.\n"
      )
    );
    return;
  }

  if (
    !discovery.deviceAuthorizationEndpoint ||
    !discovery.registrationEndpoint ||
    !discovery.grantTypesSupported.includes(DEVICE_CODE_GRANT_TYPE)
  ) {
    console.log(
      chalk.red(
        `\n  ${discovery.issuer} does not advertise the device-code grant.`
      )
    );
    console.log(
      chalk.dim("  Use `--token <pat>` with a personal access token instead.\n")
    );
    return;
  }

  console.log(chalk.dim(`\n  Context: ${target.name}`));
  console.log(chalk.dim(`  Issuer:  ${discovery.issuer}`));

  let client: RegisteredClient;
  try {
    client = await registerClient(
      discovery.registrationEndpoint,
      options.cliVersion ?? "unknown"
    );
  } catch (err) {
    console.log(chalk.red(`\n  ${(err as Error).message}\n`));
    return;
  }

  let authorization: DeviceAuthorization;
  try {
    authorization = await startDeviceAuthorization(
      discovery.deviceAuthorizationEndpoint,
      client
    );
  } catch (err) {
    console.log(chalk.red(`\n  ${(err as Error).message}\n`));
    return;
  }

  const verificationUrl =
    authorization.verificationUriComplete ?? authorization.verificationUri;

  console.log(chalk.dim("\n  Open this URL to approve the login:"));
  console.log(chalk.cyan(`  ${verificationUrl}`));
  console.log(chalk.dim(`  Code: ${chalk.bold.white(authorization.userCode)}`));
  if (
    authorization.verificationUriComplete &&
    authorization.verificationUriComplete !== authorization.verificationUri
  ) {
    console.log(chalk.dim(`  Or visit: ${authorization.verificationUri}\n`));
  } else {
    console.log();
  }

  try {
    await open(verificationUrl);
  } catch {
    // The URL is printed above; opening is best-effort.
  }

  const spinner = ora("Waiting for authorization...").start();
  const deadline = Date.now() + authorization.expiresIn * 1000;
  let intervalSeconds = authorization.interval;

  while (Date.now() < deadline) {
    await delay(intervalSeconds * 1000);

    const result = await pollDeviceToken(
      discovery.tokenEndpoint,
      client,
      authorization.deviceCode
    );

    if (result.status === "pending") {
      intervalSeconds = bumpInterval(intervalSeconds, result.bumpInterval);
      continue;
    }

    if (result.status === "error") {
      spinner.fail(result.message);
      console.log();
      return;
    }

    const tokens = result.tokens;
    let identity: { email?: string; name?: string; userId?: string } = {};
    if (discovery.userinfoEndpoint) {
      const info = await fetchUserInfo(
        discovery.userinfoEndpoint,
        tokens.accessToken
      );
      if (info) {
        identity = { email: info.email, name: info.name, userId: info.sub };
      }
    }

    const oauth: OAuthClientInfo = {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: discovery.tokenEndpoint,
      revocationEndpoint: discovery.revocationEndpoint,
      userinfoEndpoint: discovery.userinfoEndpoint,
    };

    await saveCredentials(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt:
          typeof tokens.expiresIn === "number"
            ? Date.now() + tokens.expiresIn * 1000
            : undefined,
        ...identity,
        oauth,
      },
      target.name
    );

    spinner.succeed(`Logged in to ${target.name}.`);
    console.log();
    return;
  }

  spinner.fail("Login request expired. Run `lobu login` again.");
  console.log();
}

async function loginWithToken(
  target: { apiUrl: string; name: string },
  rawToken: string
): Promise<void> {
  const token = rawToken.trim();
  if (!token) {
    console.log(chalk.red("\n  Token cannot be empty.\n"));
    return;
  }

  await saveCredentials({ accessToken: token }, target.name);
  console.log(chalk.green(`\n  Logged in to ${target.name} with API token.\n`));
}

async function revokeExisting(existing: Credentials): Promise<void> {
  const oauth = existing.oauth;
  if (!oauth?.revocationEndpoint || !oauth.clientId) return;

  const client: RegisteredClient = {
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
  };

  if (existing.refreshToken) {
    await revokeToken(
      oauth.revocationEndpoint,
      client,
      existing.refreshToken,
      "refresh_token"
    );
  }
  await revokeToken(
    oauth.revocationEndpoint,
    client,
    existing.accessToken,
    "access_token"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import chalk from "chalk";
import inquirer from "inquirer";
import open from "open";
import ora from "ora";
import {
  clearCredentials,
  loadCredentials,
  resolveContext,
  saveCredentials,
} from "@lobu/cli-core";

function extractIdentity(payload: unknown): {
  email?: string;
  name?: string;
  userId?: string;
  agentId?: string;
} {
  if (!payload || typeof payload !== "object") return {};

  const record = payload as Record<string, unknown>;
  const user =
    record.user && typeof record.user === "object"
      ? (record.user as Record<string, unknown>)
      : null;

  const email =
    typeof record.email === "string"
      ? record.email
      : typeof user?.email === "string"
        ? user.email
        : undefined;
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof user?.name === "string"
        ? user.name
        : undefined;
  const userId =
    typeof record.userId === "string"
      ? record.userId
      : typeof record.id === "string"
        ? record.id
        : typeof user?.id === "string"
          ? user.id
          : undefined;

  const agentId =
    typeof record.agentId === "string"
      ? record.agentId
      : typeof record.agent_id === "string"
        ? record.agent_id
        : undefined;

  return { email, name, userId, agentId };
}

async function validateToken(
  token: string,
  apiBaseUrl: string
): Promise<
  | {
      status: "valid";
      email?: string;
      name?: string;
      userId?: string;
      agentId?: string;
    }
  | { status: "invalid"; error: string }
  | { status: "unverified"; warning: string }
> {
  try {
    const response = await fetch(`${apiBaseUrl}/auth/whoami`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Lobu-Org": "default",
      },
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: "invalid",
        error: "Token was rejected by the API (unauthorized).",
      };
    }

    if (!response.ok) {
      return {
        status: "unverified",
        warning:
          "Could not validate token against API (non-200 response), but token was saved locally.",
      };
    }

    const body = (await response.json().catch(() => ({}))) as unknown;
    const identity = extractIdentity(body);
    return { status: "valid", ...identity };
  } catch {
    return {
      status: "unverified",
      warning:
        "Could not reach API to validate token, but token was saved locally.",
    };
  }
}

export async function loginCommand(options: {
  token?: string;
  adminPassword?: boolean;
  context?: string;
  force?: boolean;
}): Promise<void> {
  const target = await resolveContext(options.context);

  if (options.token && options.adminPassword) {
    console.log(
      chalk.red("\n  Use either `--token` or `--admin-password`, not both.\n")
    );
    return;
  }

  // Check existing session — block unless --force
  const existing = await loadCredentials(target.name);
  if (existing && !options.force) {
    console.log(
      chalk.dim(
        `\n  Already logged in to ${target.name} as ${existing.email ?? existing.name ?? "user"}.`
      )
    );
    console.log(
      chalk.dim(
        "  Run `npx @lobu/cli@latest logout` first, or use `--force` to re-authenticate.\n"
      )
    );
    return;
  }

  // Force: revoke existing session before proceeding
  if (existing && options.force) {
    if (existing.refreshToken) {
      try {
        await fetch(`${target.apiUrl}/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: existing.refreshToken }),
        });
      } catch {
        // Best-effort revocation
      }
    }
    await clearCredentials(target.name);
  }

  if (options.token) {
    const token = options.token.trim();
    if (!token) {
      console.log(chalk.red("\n  Token cannot be empty.\n"));
      return;
    }

    const validation = await validateToken(token, target.apiUrl);
    if (validation.status === "invalid") {
      console.log(chalk.red(`\n  ${validation.error}`));
      console.log(chalk.dim("  Check LOBU_API_URL or generate a new token.\n"));
      return;
    }

    await saveCredentials(
      {
        accessToken: token,
        email: validation.status === "valid" ? validation.email : undefined,
        name: validation.status === "valid" ? validation.name : undefined,
        userId: validation.status === "valid" ? validation.userId : undefined,
        agentId: validation.status === "valid" ? validation.agentId : undefined,
      },
      target.name
    );

    if (validation.status === "valid") {
      console.log(
        chalk.green(`\n  Logged in to ${target.name} with API token.\n`)
      );
    } else {
      console.log(chalk.yellow(`\n  ${validation.warning}`));
      console.log(
        chalk.green(`  Logged in to ${target.name} with API token.\n`)
      );
    }
    return;
  }

  if (options.adminPassword) {
    const answers = await inquirer.prompt([
      {
        type: "password",
        name: "password",
        message: `Admin password for ${target.name}:`,
        mask: "*",
      },
    ]);
    const password =
      answers && typeof answers.password === "string"
        ? answers.password.trim()
        : "";

    if (!password) {
      console.log(chalk.red("\n  Password cannot be empty.\n"));
      return;
    }

    const response = await fetch(`${target.apiUrl}/auth/cli/admin-login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lobu-Org": "default",
      },
      body: JSON.stringify({ password }),
    }).catch(() => null);

    if (!response) {
      console.log(chalk.red("  Failed to reach the Lobu API.\n"));
      return;
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      user?: {
        userId?: string;
        email?: string;
        name?: string;
      };
    };

    if (!response.ok || !body.accessToken || !body.refreshToken) {
      const error =
        body && typeof body.error === "string"
          ? body.error
          : "Admin password login failed.";
      console.log(chalk.red(`\n  ${error}\n`));
      return;
    }

    await saveCredentials(
      {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAt: body.expiresAt,
        userId: body.user?.userId,
        email: body.user?.email,
        name: body.user?.name,
      },
      target.name
    );

    console.log(
      chalk.yellow(
        `\n  Logged in to ${target.name} using the development admin password fallback.\n`
      )
    );
    return;
  }

  console.log(chalk.bold.cyan("\n  Lobu Cloud is in early access.\n"));
  console.log(chalk.dim(`  Context: ${target.name}`));
  console.log(chalk.dim(`  API URL: ${target.apiUrl}`));

  const startResponse = await fetch(`${target.apiUrl}/auth/cli/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Lobu-Org": "default",
    },
  }).catch(() => null);

  if (!startResponse) {
    console.log(chalk.red("  Failed to reach the Lobu API.\n"));
    return;
  }

  if (!startResponse.ok) {
    const body = await startResponse
      .json()
      .catch(() => ({ error: "CLI login is unavailable." }));
    const error =
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : "CLI login is unavailable.";
    console.log(chalk.red(`  ${error}\n`));
    return;
  }

  const startBody = (await startResponse.json()) as {
    mode: "browser" | "device";
    requestId?: string;
    loginUrl?: string;
    pollIntervalMs?: number;
    deviceAuthId?: string;
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete?: string;
    interval?: number;
    expiresAt?: number;
  };

  let spinnerMessage = "Waiting for login...";
  let pollBodyInput: { requestId?: string; deviceAuthId?: string };
  let pollIntervalMs = 2000;

  if (startBody.mode === "device" && startBody.deviceAuthId) {
    const verificationUrl =
      startBody.verificationUriComplete || startBody.verificationUri;
    console.log(chalk.dim("\n  Device login required."));
    if (startBody.userCode) {
      console.log(chalk.dim(`  Code: ${chalk.bold.white(startBody.userCode)}`));
    }
    if (verificationUrl) {
      console.log(chalk.dim("  Visit:"));
      console.log(chalk.cyan(`  ${verificationUrl}`));
    }
    if (
      startBody.verificationUri &&
      verificationUrl !== startBody.verificationUri
    ) {
      console.log(chalk.dim("  Alternate URL:"));
      console.log(chalk.cyan(`  ${startBody.verificationUri}`));
    }
    console.log();

    if (verificationUrl) {
      try {
        await open(verificationUrl);
      } catch {
        // Printed above.
      }
    }

    spinnerMessage = "Waiting for device authorization...";
    pollBodyInput = { deviceAuthId: startBody.deviceAuthId };
    pollIntervalMs = Math.max((startBody.interval ?? 5) * 1000, 1000);
  } else if (
    startBody.mode === "browser" &&
    startBody.requestId &&
    startBody.loginUrl
  ) {
    console.log(chalk.dim("  Opening browser to authenticate...\n"));

    try {
      await open(startBody.loginUrl);
      console.log(chalk.dim(`  If the browser didn't open, visit:`));
      console.log(chalk.cyan(`  ${startBody.loginUrl}\n`));
    } catch {
      console.log(chalk.dim(`  Open this URL in your browser:`));
      console.log(chalk.cyan(`  ${startBody.loginUrl}\n`));
    }

    spinnerMessage = "Waiting for browser login...";
    pollBodyInput = { requestId: startBody.requestId };
    pollIntervalMs = Math.max(startBody.pollIntervalMs ?? 2000, 1000);
  } else {
    console.log(chalk.red("  CLI login is unavailable.\n"));
    return;
  }

  const spinner = ora(spinnerMessage).start();
  const deadline = startBody.expiresAt ?? Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    await delay(pollIntervalMs);

    const pollResponse = await fetch(`${target.apiUrl}/auth/cli/poll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lobu-Org": "default",
      },
      body: JSON.stringify(pollBodyInput),
    }).catch(() => null);

    if (!pollResponse) {
      spinner.fail("Lost connection to the Lobu API.");
      console.log();
      return;
    }

    const pollBody = (await pollResponse.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      user?: {
        userId?: string;
        email?: string;
        name?: string;
      };
    };

    if (pollBody.status === "pending") {
      continue;
    }

    if (pollBody.status === "error") {
      spinner.fail(pollBody.error || "Authentication failed.");
      console.log();
      return;
    }

    if (
      pollBody.status === "complete" &&
      pollBody.accessToken &&
      pollBody.refreshToken
    ) {
      await saveCredentials(
        {
          accessToken: pollBody.accessToken,
          refreshToken: pollBody.refreshToken,
          expiresAt: pollBody.expiresAt,
          userId: pollBody.user?.userId,
          email: pollBody.user?.email,
          name: pollBody.user?.name,
        },
        target.name
      );
      spinner.succeed(`Authenticated with Lobu Cloud (${target.name}).`);
      console.log();
      return;
    }
  }

  spinner.fail(
    "Login request expired. Run `npx @lobu/cli@latest login` again."
  );
  console.log();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

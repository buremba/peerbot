/**
 * Shared platform connection prompt/config logic.
 * Used by both `lobu init` and `lobu connections add <platform>`.
 */

import inquirer from "inquirer";

interface PlatformPromptResult {
  connectionConfig: Record<string, string>;
  connectionSecrets: Array<{ envVar: string; value: string }>;
}

export const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  teams: "Microsoft Teams",
  gchat: "Google Chat",
};

export async function promptPlatformConfig(
  platform: string
): Promise<PlatformPromptResult> {
  const connectionConfig: Record<string, string> = {};
  const connectionSecrets: Array<{ envVar: string; value: string }> = [];

  if (platform === "telegram") {
    const { botToken } = await inquirer.prompt([
      {
        type: "password",
        name: "botToken",
        message: "Telegram bot token (from @BotFather):",
        mask: "*",
      },
    ]);
    if (botToken) {
      connectionConfig.botToken = "$TELEGRAM_BOT_TOKEN";
      connectionSecrets.push({ envVar: "TELEGRAM_BOT_TOKEN", value: botToken });
    }
  } else if (platform === "slack") {
    console.log(
      "\nCreate a Slack app for this agent, then paste its bot token + signing secret below."
    );
    console.log(
      "  1. Visit https://api.slack.com/apps → 'Create New App' → 'From an app manifest'"
    );
    console.log(
      "  2. Pick your workspace, then paste the self-install manifest template:"
    );
    console.log(
      "     https://github.com/lobu-ai/lobu/blob/main/config/slack-app-manifest.self-install.json"
    );
    console.log(
      "     (or run: SLACK_MANIFEST_PATH=config/slack-app-manifest.self-install.json \\"
    );
    console.log("              PUBLIC_GATEWAY_URL=<your gateway URL> \\");
    console.log("              SLACK_CONNECTION_ID=<agent>-slack \\");
    console.log("              bun run scripts/slack-manifest.ts print)");
    console.log(
      "  3. In the manifest, replace the request URLs with https://<gateway>/api/v1/webhooks/<agent>-slack"
    );
    console.log(
      "  4. Install the app to your workspace to mint the bot token.\n"
    );
    const slackAnswers = await inquirer.prompt([
      {
        type: "password",
        name: "botToken",
        message: "Slack bot token (xoxb-...):",
        mask: "*",
      },
      {
        type: "password",
        name: "signingSecret",
        message: "Slack signing secret:",
        mask: "*",
      },
    ]);
    if (slackAnswers.botToken) {
      connectionConfig.botToken = "$SLACK_BOT_TOKEN";
      connectionSecrets.push({
        envVar: "SLACK_BOT_TOKEN",
        value: slackAnswers.botToken,
      });
    }
    if (slackAnswers.signingSecret) {
      connectionConfig.signingSecret = "$SLACK_SIGNING_SECRET";
      connectionSecrets.push({
        envVar: "SLACK_SIGNING_SECRET",
        value: slackAnswers.signingSecret,
      });
    }
  } else if (platform === "discord") {
    const { botToken } = await inquirer.prompt([
      {
        type: "password",
        name: "botToken",
        message: "Discord bot token:",
        mask: "*",
      },
    ]);
    if (botToken) {
      connectionConfig.botToken = "$DISCORD_BOT_TOKEN";
      connectionSecrets.push({ envVar: "DISCORD_BOT_TOKEN", value: botToken });
    }
  } else if (platform === "whatsapp") {
    const whatsappAnswers = await inquirer.prompt([
      {
        type: "password",
        name: "accessToken",
        message: "WhatsApp Business access token:",
        mask: "*",
      },
      {
        type: "input",
        name: "phoneNumberId",
        message: "WhatsApp phone number ID:",
      },
    ]);
    if (whatsappAnswers.accessToken) {
      connectionConfig.accessToken = "$WHATSAPP_ACCESS_TOKEN";
      connectionSecrets.push({
        envVar: "WHATSAPP_ACCESS_TOKEN",
        value: whatsappAnswers.accessToken,
      });
    }
    if (whatsappAnswers.phoneNumberId) {
      connectionConfig.phoneNumberId = "$WHATSAPP_PHONE_NUMBER_ID";
      connectionSecrets.push({
        envVar: "WHATSAPP_PHONE_NUMBER_ID",
        value: whatsappAnswers.phoneNumberId,
      });
    }
  } else if (platform === "teams") {
    const teamsAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "appId",
        message: "Teams App ID (from Azure Bot):",
      },
      {
        type: "password",
        name: "appPassword",
        message: "Teams App Password (client secret):",
        mask: "*",
      },
    ]);
    if (teamsAnswers.appId) {
      connectionConfig.appId = "$TEAMS_APP_ID";
      connectionSecrets.push({
        envVar: "TEAMS_APP_ID",
        value: teamsAnswers.appId,
      });
    }
    if (teamsAnswers.appPassword) {
      connectionConfig.appPassword = "$TEAMS_APP_PASSWORD";
      connectionSecrets.push({
        envVar: "TEAMS_APP_PASSWORD",
        value: teamsAnswers.appPassword,
      });
    }
  } else if (platform === "gchat") {
    const { credentials } = await inquirer.prompt([
      {
        type: "password",
        name: "credentials",
        message: "Google Chat service account JSON:",
        mask: "*",
      },
    ]);
    if (credentials) {
      connectionConfig.credentials = "$GOOGLE_CHAT_CREDENTIALS";
      connectionSecrets.push({
        envVar: "GOOGLE_CHAT_CREDENTIALS",
        value: credentials,
      });
    }
  }

  return { connectionConfig, connectionSecrets };
}

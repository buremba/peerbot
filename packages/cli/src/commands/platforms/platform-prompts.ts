/**
 * Shared platform prompt/config logic.
 * Used by `lobu init` when scaffolding optional local platform config.
 */

import { input, password } from "@inquirer/prompts";

interface PlatformPromptResult {
  platformConfig: Record<string, string>;
  platformSecrets: Array<{ envVar: string; value: string }>;
}

export async function promptPlatformConfig(
  platform: string
): Promise<PlatformPromptResult> {
  const platformConfig: Record<string, string> = {};
  const platformSecrets: Array<{ envVar: string; value: string }> = [];

  if (platform === "telegram") {
    const botToken = await password({
      message: "Telegram bot token (from @BotFather):",
      mask: true,
    });
    if (botToken) {
      platformConfig.botToken = "$TELEGRAM_BOT_TOKEN";
      platformSecrets.push({ envVar: "TELEGRAM_BOT_TOKEN", value: botToken });
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
    const slackBotToken = await password({
      message: "Slack bot token (xoxb-...):",
      mask: true,
    });
    const slackSigningSecret = await password({
      message: "Slack signing secret:",
      mask: true,
    });
    if (slackBotToken) {
      platformConfig.botToken = "$SLACK_BOT_TOKEN";
      platformSecrets.push({
        envVar: "SLACK_BOT_TOKEN",
        value: slackBotToken,
      });
    }
    if (slackSigningSecret) {
      platformConfig.signingSecret = "$SLACK_SIGNING_SECRET";
      platformSecrets.push({
        envVar: "SLACK_SIGNING_SECRET",
        value: slackSigningSecret,
      });
    }
  } else if (platform === "discord") {
    const botToken = await password({
      message: "Discord bot token:",
      mask: true,
    });
    if (botToken) {
      platformConfig.botToken = "$DISCORD_BOT_TOKEN";
      platformSecrets.push({ envVar: "DISCORD_BOT_TOKEN", value: botToken });
    }
  } else if (platform === "whatsapp") {
    const accessToken = await password({
      message: "WhatsApp Business access token:",
      mask: true,
    });
    const phoneNumberId = await input({
      message: "WhatsApp phone number ID:",
    });
    if (accessToken) {
      platformConfig.accessToken = "$WHATSAPP_ACCESS_TOKEN";
      platformSecrets.push({
        envVar: "WHATSAPP_ACCESS_TOKEN",
        value: accessToken,
      });
    }
    if (phoneNumberId) {
      platformConfig.phoneNumberId = "$WHATSAPP_PHONE_NUMBER_ID";
      platformSecrets.push({
        envVar: "WHATSAPP_PHONE_NUMBER_ID",
        value: phoneNumberId,
      });
    }
  } else if (platform === "teams") {
    const appId = await input({
      message: "Teams App ID (from Azure Bot):",
    });
    const appPassword = await password({
      message: "Teams App Password (client secret):",
      mask: true,
    });
    if (appId) {
      platformConfig.appId = "$TEAMS_APP_ID";
      platformSecrets.push({
        envVar: "TEAMS_APP_ID",
        value: appId,
      });
    }
    if (appPassword) {
      platformConfig.appPassword = "$TEAMS_APP_PASSWORD";
      platformSecrets.push({
        envVar: "TEAMS_APP_PASSWORD",
        value: appPassword,
      });
    }
  } else if (platform === "gchat") {
    const credentials = await password({
      message: "Google Chat service account JSON:",
      mask: true,
    });
    if (credentials) {
      platformConfig.credentials = "$GOOGLE_CHAT_CREDENTIALS";
      platformSecrets.push({
        envVar: "GOOGLE_CHAT_CREDENTIALS",
        value: credentials,
      });
    }
  }

  return { platformConfig, platformSecrets };
}

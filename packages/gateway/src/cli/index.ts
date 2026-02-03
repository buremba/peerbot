#!/usr/bin/env bun

import {
  ConfigError,
  createLogger,
  initSentry,
  initTracing,
} from "@peerbot/core";
import { Command } from "commander";
import {
  buildGatewayConfig,
  displayGatewayConfig,
  loadEnvFile,
} from "../config";
import { buildSlackConfig, displaySlackConfig } from "../slack/config";
import { buildWhatsAppConfig, displayWhatsAppConfig } from "../whatsapp/config";
import { startGateway } from "./gateway";

const logger = createLogger("cli");

/**
 * CLI entry point - handles all command-line arguments and configuration
 */
async function main() {
  // Initialize Sentry monitoring (fire and forget)
  initSentry().catch(console.error);

  const program = new Command();

  program
    .name("peerbot-gateway")
    .description("Peerbot gateway service - connects Slack to Claude workers")
    .version("1.0.0");

  // WhatsApp setup command
  program
    .command("whatsapp-setup")
    .description(
      "One-time WhatsApp QR code setup - outputs WHATSAPP_CREDENTIALS"
    )
    .action(async () => {
      try {
        const { runWhatsAppSetup } = await import("../whatsapp/setup");
        await runWhatsAppSetup();
        process.exit(0);
      } catch (error) {
        logger.error(
          "WhatsApp setup failed:",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  // Main gateway command (default)
  program
    .option("--env <path>", "Path to .env file (default: .env)")
    .option("--validate", "Validate configuration and exit")
    .option("--show-config", "Display parsed configuration and exit")
    .action(async (options) => {
      try {
        // Load environment variables
        loadEnvFile(options.env);

        // Initialize OpenTelemetry tracing for Tempo (if configured)
        initTracing({
          serviceName: "peerbot-gateway",
          serviceVersion: process.env.npm_package_version || "2.0.0",
          tempoEndpoint: process.env.TEMPO_ENDPOINT, // e.g., "http://peerbot-tempo:4318/v1/traces"
          enabled: !!process.env.TEMPO_ENDPOINT,
        });

        // Build configuration from environment
        const config = buildGatewayConfig();
        const slackConfig = buildSlackConfig();
        const whatsappConfig = buildWhatsAppConfig();

        // Handle --validate flag
        if (options.validate) {
          console.log("✅ Configuration is valid");
          displayGatewayConfig(config);
          displaySlackConfig(slackConfig);
          displayWhatsAppConfig(whatsappConfig);
          process.exit(0);
        }

        // Handle --show-config flag
        if (options.showConfig) {
          displayGatewayConfig(config);
          displaySlackConfig(slackConfig);
          displayWhatsAppConfig(whatsappConfig);
          process.exit(0);
        }

        // Start the gateway
        await startGateway(config, slackConfig, whatsappConfig);
      } catch (error) {
        if (error instanceof ConfigError) {
          logger.error("❌ Configuration error:", error.message);
          process.exit(1);
        }
        logger.error(
          "❌ Failed to start gateway:",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

// Run CLI
main().catch((error) => {
  logger.error("❌ CLI error:", error);
  process.exit(1);
});

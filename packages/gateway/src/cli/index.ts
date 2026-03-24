#!/usr/bin/env bun

import { ConfigError, createLogger, initSentry, initTracing } from "@lobu/core";
import { Command } from "commander";
import {
  buildGatewayConfig,
  displayGatewayConfig,
  loadEnvFile,
} from "../config";
import { startGateway } from "./gateway";

const logger = createLogger("cli");

async function main() {
  const program = new Command();

  program
    .name("lobu-gateway")
    .description(
      "Lobu gateway service — API-driven platform connections via Chat SDK"
    )
    .version("1.0.0");

  program
    .option("--env <path>", "Path to .env file (default: .env)")
    .option("--validate", "Validate configuration and exit")
    .option("--show-config", "Display parsed configuration and exit")
    .action(async (options) => {
      try {
        loadEnvFile(options.env);

        await initSentry();

        initTracing({
          serviceName: "lobu-gateway",
          serviceVersion: process.env.npm_package_version || "2.0.0",
          tempoEndpoint: process.env.TEMPO_ENDPOINT,
          enabled: !!process.env.TEMPO_ENDPOINT,
        });

        const config = buildGatewayConfig();

        if (options.validate) {
          console.log("Configuration is valid");
          displayGatewayConfig(config);
          process.exit(0);
        }

        if (options.showConfig) {
          displayGatewayConfig(config);
          process.exit(0);
        }

        await startGateway(config);
      } catch (error) {
        if (error instanceof ConfigError) {
          logger.error("Configuration error:", error.message);
          process.exit(1);
        }
        logger.error(
          "Failed to start gateway:",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  logger.error("CLI error:", error);
  process.exit(1);
});

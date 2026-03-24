import { createLogger, type Logger } from "./logger";

// Lazy logger initialization to avoid circular dependency
let _logger: Logger | null = null;
function getLogger(): Logger {
  if (!_logger) {
    _logger = createLogger("sentry");
  }
  return _logger;
}

let sentryInstance: typeof import("@sentry/node") | null = null;

/**
 * Initialize Sentry with configuration from environment variables
 * Falls back to hardcoded DSN if SENTRY_DSN is not provided
 * Uses dynamic import to avoid module resolution issues in dev mode
 */
export async function initSentry() {
  try {
    const Sentry = await import("@sentry/node");
    sentryInstance = Sentry;

    const sentryDsn =
      process.env.SENTRY_DSN ||
      "https://c5910e58d1a134d64ff93a95a9c535bb@o4507291398897664.ingest.us.sentry.io/4511097466781696";

    Sentry.init({
      dsn: sentryDsn,
      sendDefaultPii: true,
      profileSessionSampleRate: 1.0,
      tracesSampleRate: 1.0, // Capture 100% of traces for better visibility
      integrations: [
        Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
        Sentry.redisIntegration(),
      ],
    });

    getLogger().debug("Sentry monitoring initialized");
  } catch (error) {
    getLogger().warn(
      "⚠️ Sentry initialization failed (continuing without monitoring):",
      error
    );
  }
}

/**
 * Get the initialized Sentry instance
 * @returns Sentry instance or null if not initialized
 */
export function getSentry(): typeof import("@sentry/node") | null {
  return sentryInstance;
}

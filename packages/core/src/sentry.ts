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
 * Initialize Sentry with configuration from environment variables.
 * Only initializes if SENTRY_DSN is set — no implicit error reporting.
 * Uses dynamic import to avoid module resolution issues in dev mode.
 */
export async function initSentry() {
  const sentryDsn = process.env.SENTRY_DSN;
  if (!sentryDsn) {
    getLogger().debug("Sentry disabled (no SENTRY_DSN configured)");
    return;
  }

  try {
    const Sentry = await import("@sentry/node");
    sentryInstance = Sentry;

    Sentry.init({
      dsn: sentryDsn,
      // Do not ship IP/cookies/headers by default — user content and identifiers
      // travel through this stack and Sentry has no scrubbing for our schema.
      sendDefaultPii: false,
      profileSessionSampleRate: 1.0,
      tracesSampleRate: 1.0, // Capture 100% of traces for better visibility
      integrations: [
        Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
      ],
    });

    getLogger().debug("Sentry monitoring initialized");
  } catch (error) {
    getLogger().warn(
      "Sentry initialization failed (continuing without monitoring):",
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

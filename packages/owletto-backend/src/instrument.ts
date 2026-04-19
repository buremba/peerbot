/**
 * Sentry Instrumentation — must be imported before all other modules.
 *
 * @sentry/node v9 uses OpenTelemetry under the hood to auto-instrument:
 * - postgres (postgres.js) and pg (node-postgres)
 * - HTTP/fetch outgoing requests
 * - Node.js core modules
 *
 * This file is imported as the very first line in server.ts.
 */

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  const isDev = process.env.NODE_ENV === 'development' || process.env.ENVIRONMENT === 'development';

  Sentry.init({
    dsn,
    environment: process.env.ENVIRONMENT || 'production',
    tracesSampleRate: isDev ? 1.0 : 0.1,
  });
}

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

import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

// .env is the single source of truth for secrets. This module reads SENTRY_DSN
// (and ENVIRONMENT / SENTRY_RELEASE) at load time and is imported before any
// other module — so it must load .env itself, or Sentry would be silently
// disabled in any deployment that keeps the DSN in .env. dotenv.config() is
// idempotent (it doesn't override already-set vars), so a later call is fine.
dotenv.config();

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  const isDev = process.env.NODE_ENV === 'development' || process.env.ENVIRONMENT === 'development';

  Sentry.init({
    dsn,
    environment: process.env.ENVIRONMENT || 'production',
    release: process.env.SENTRY_RELEASE || process.env.APP_GIT_SHA || undefined,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    // Error events: 100% in dev, 50% in prod. The org quota was previously
    // exhausted by background-job captureMessage spam (since removed — see
    // runs-queue.ts); sampling at 0.5 buys ~2x quota headroom while still
    // giving plenty of signal for new issues. A fingerprint-level beforeSend
    // filter would be more precise but adds maintenance — bump back to 1.0
    // here if the Sentry plan/quota gets raised.
    sampleRate: isDev ? 1.0 : 0.5,
    // The NodeSystemError integration calls util.getSystemErrorMap(), which
    // some Node builds we run under (notably v24.x in our app image) don't
    // expose. The integration itself then throws inside the event processor
    // and the underlying exception never reaches Sentry. Drop it. (Sentry:
    // LOBU-36.)
    integrations: (defaults) => defaults.filter((i) => i.name !== 'NodeSystemError'),
  });
}

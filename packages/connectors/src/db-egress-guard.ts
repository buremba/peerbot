/**
 * Database-URL policy for the Postgres connector: which egress policy a run is
 * under, and the TLS it must therefore use.
 *
 * The ADDRESS half of DB egress is not here. A connector runs only on the
 * isolate lane, where the guest cannot resolve a name: the HOST resolves and
 * dials every socket (`socketOpen` in `connector-worker/src/executor/isolate.ts`)
 * through the one egress transport (`@lobu/connector-worker/egress`), applying
 * `LOBU_DB_EGRESS_POLICY` and the operator's `LOBU_DB_EGRESS_ALLOW_HOSTS`
 * exemptions to every resolved address, and pinning the socket to the address
 * it validated. A multi-host authority (`postgres://u:p@h1,h2/db`) needs no
 * parser here any more: postgres.js dials each failover host through its own
 * `connect()`, so every host is checked at `socketOpen` as it is tried. The
 * policy values themselves are
 * `@lobu/connector-sdk/ip-reachability`'s {@link EgressAddressPolicy}.
 *
 * The TLS half stays connector-side because nothing on the wire tells the host
 * that a socket carries database credentials, and postgres.js only upgrades a
 * connection when the pool was handed `ssl`. Under `block-private` (untrusted
 * cloud) the connector therefore forces TLS from the URL's own parameters
 * (`requiredTlsMode`; `sslmode=disable` is refused outright), and under every
 * policy it refuses a URL that asks for chain verification the lane cannot yet
 * deliver (`requestedTlsMode`; see `openGuardedPool` in `postgres.ts`).
 *
 * DEFERRED (explicit follow-up, not a gap in the platform boundary): a per-org
 * destination allowlist ("this org may only reach these DB hosts").
 * block-private + host-side pinning + forced TLS is what protects the PLATFORM
 * (no internal/metadata/tenant lateral movement, no plaintext creds on the
 * wire); an allowlist protects a tenant from its own operators and is an
 * enterprise policy feature layered on top later.
 */
import type { EgressAddressPolicy } from '@lobu/connector-sdk/ip-reachability';

/** Map a free-form policy string (from config/env) to the enum; default is the
 *  trusted `allow-private` so first-party/self-hosted is never broken — cloud
 *  paths inject `block-private` explicitly. */
export function readEgressPolicy(value: unknown): EgressAddressPolicy {
  return value === 'block-private' ? 'block-private' : 'allow-private';
}

/**
 * The `ssl` value to FORCE onto postgres.js under `block-private`, derived from
 * the URL's own `sslmode`/`ssl` params (`sslmode` wins when both are present —
 * postgres.js maps `sslmode` over `ssl`). An explicit `ssl` option key overrides
 * the URL in postgres.js (`k in o` beats `k in query`), so returning a value
 * here is authoritative. Rules (monotone — never weakens what the URL asked for):
 *  - `disable` / `false` → REJECT: a tenant URL on cloud must never carry
 *    credentials or rows in plaintext across the internet.
 *  - absent / `allow` / `prefer` / `require` → `'require'` (encrypt always;
 *    `prefer` would silently fall back to plaintext when the server declines).
 *  - `verify-ca` / `verify-full` (or any other explicit value, e.g. `true`) →
 *    passed through unchanged: postgres.js treats non-require/allow/prefer
 *    strings as strict TLS (`rejectUnauthorized` stays on).
 *
 * Why the FLOOR is `require` (encrypt, don't verify the chain) and not
 * `verify-full`: tenant databases very commonly present self-signed or
 * private-CA certs (RDS regional bundles, on-prem), so forcing verify-full
 * would hard-break most legitimate BYO databases with no recourse until we
 * ship per-connection CA upload. `require` matches libpq's semantics for the
 * same flag. Upgrading the floor to verify-full once CA upload exists is the
 * noted follow-up — and the pinned-socket design already keeps it sound: the
 * TLS `servername` stays the ORIGINAL hostname (not the pinned IP), so SNI
 * routing and, when verification is on, certificate identity both check
 * against the name the tenant configured.
 */
export function requiredTlsMode(connectionString: string): string {
  const mode = requestedTlsMode(connectionString);
  if (mode === 'disable' || mode === 'false') {
    throw new Error(
      'DATABASE_URL disables TLS (sslmode=disable), but TLS is required on this deployment (egress policy: block-private). Use sslmode=require or stronger.',
    );
  }
  if (mode === '' || mode === 'allow' || mode === 'prefer' || mode === 'require') {
    return 'require';
  }
  return mode;
}

/**
 * The TLS mode postgres.js will actually apply to this connection string — the
 * pure parse half of `requiredTlsMode`, with no deployment policy attached.
 * Returns `''` when the URL says nothing about TLS, otherwise the lowercased
 * last-wins `sslmode` (falling back to `ssl`), with `sslrootcert=system`
 * forcing `verify-full` exactly as the driver does. Read this where the
 * question is whether the tenant ASKED for certificate verification
 * (`verify-ca` / `verify-full`) — an execution lane that cannot deliver it must
 * refuse rather than connect unverified behind a verifying-looking URL.
 */
export function requestedTlsMode(connectionString: string): string {
  // postgres.js parses the URL with `new URL()`, whose `.searchParams` follows
  // WHATWG URL semantics: the fragment (everything from the FIRST `#`) is NOT
  // part of the query, and a `?` that appears AFTER that `#` is fragment text,
  // not a query delimiter. So cut the fragment off the WHOLE string first, then
  // locate `?`. This closes both `?x=y#frag` (folding `#frag` into the last
  // value) and `#frag?sslmode=disable` (a `?` living inside the fragment being
  // misread as a real query) — either would silently corrupt the TLS decision.
  const hash = connectionString.indexOf('#');
  const beforeFragment =
    hash === -1 ? connectionString : connectionString.slice(0, hash);
  const q = beforeFragment.indexOf('?');
  const params = new URLSearchParams(q === -1 ? '' : beforeFragment.slice(q + 1));
  // Match postgres.js's own precedence exactly (connection.js parseOptions):
  // it reduces searchParams into an object so on DUPLICATE keys the LAST value
  // wins, then maps `sslmode` over `ssl` (sslmode present ⇒ ssl := sslmode).
  // `URLSearchParams.get` returns the FIRST value, so using it would let
  // `?sslmode=require&sslmode=verify-full` read `require` and silently DOWNGRADE
  // the strict TLS the driver would actually apply. Read last-wins for both keys,
  // sslmode taking priority when present.
  // postgres.js only maps sslmode over ssl when the (last) sslmode is truthy
  // (`query.sslmode && ...`), so an empty `?sslmode=` falls through to `ssl`.
  const lastSslmode = params.getAll('sslmode').at(-1);
  const lastSsl = params.getAll('ssl').at(-1);
  const mode = ((lastSslmode || lastSsl) ?? '').toLowerCase();
  // postgres.js applies `sslrootcert=system` LAST and UNCONDITIONALLY forces
  // `ssl = 'verify-full'` (connection.js) — it runs after the sslmode→ssl
  // mapping and even overrides `sslmode=disable`, so the driver would encrypt
  // and verify regardless. Our returned value is authoritative in
  // openGuardedPool (an explicit `ssl` option beats the URL), so we must honor
  // it: otherwise a URL trusting the system CA store would be silently
  // DOWNGRADED from verify-full to require (or wrongly rejected as plaintext),
  // disabling certificate verification.
  const usesSystemCa = params.getAll('sslrootcert').at(-1)?.toLowerCase() === 'system';
  if (usesSystemCa) {
    return 'verify-full';
  }
  return mode;
}

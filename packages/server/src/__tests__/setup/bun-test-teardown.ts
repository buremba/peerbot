/**
 * Global bun:test teardown for embedded Postgres started by db-setup.ts.
 * Preload runs in the test runner root so this afterAll fires once per
 * `bun test` invocation, after every test file finishes.
 *
 * Lazy-import db-setup so unit tests that never touch Postgres do not load
 * embedded-postgres at preload time.
 */
import { afterAll } from 'bun:test';

afterAll(async () => {
  const { stopDbForGatewayTests } = await import('../../gateway/__tests__/helpers/db-setup.js');
  await stopDbForGatewayTests();
});
/**
 * PostgreSQL error helpers shared across scheduled tasks.
 */

/**
 * Check whether a caught error is a PG unique-violation (23505) on a
 * specific constraint.  Useful for idempotent INSERT … ON CONFLICT guards
 * that rely on a partial unique index rather than ON CONFLICT syntax.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const pg = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = pg.constraint ?? pg.constraint_name;
  return pg.code === '23505' && constraint === constraintName;
}

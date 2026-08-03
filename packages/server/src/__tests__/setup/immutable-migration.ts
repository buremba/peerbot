import type { MigrationSection } from '../../db/migration-loader';

/**
 * Replay immutable pre-cutover migration SQL against the current Behavior
 * schema without editing migration history. Only the retired engine vocabulary
 * changes; the migration logic remains byte-for-byte equivalent.
 */
export function adaptImmutableMigrationToBehaviorSchema(sql: string): string {
  return sql.replaceAll('watchers', 'behaviors').replaceAll('watcher', 'behavior');
}

export function adaptImmutableMigrationSection(
  section: MigrationSection,
): MigrationSection {
  return {
    ...section,
    sql: adaptImmutableMigrationToBehaviorSchema(section.sql),
  };
}

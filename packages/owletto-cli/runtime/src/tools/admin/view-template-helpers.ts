/**
 * Shared types and helpers for view template versioning.
 * Used by manage_entity_schema and manage_entity.
 */

export interface ViewTemplateVersionRow {
  id: number;
  version: number;
  tab_name: string | null;
  tab_order: number;
  json_template: Record<string, unknown>;
  change_notes: string | null;
  created_by: string;
  created_by_username: string | null;
  created_at: string;
}

export interface ViewTemplateTabInfo {
  tab_name: string;
  tab_order: number;
  current_version: number;
  current_version_id: number;
  json_template: Record<string, unknown>;
}

export function mapVersionRow(row: Record<string, unknown>): ViewTemplateVersionRow {
  return {
    id: Number(row.id),
    version: Number(row.version),
    tab_name: row.tab_name ? String(row.tab_name) : null,
    tab_order: Number(row.tab_order) || 0,
    json_template: row.json_template as Record<string, unknown>,
    change_notes: row.change_notes ? String(row.change_notes) : null,
    created_by: String(row.created_by),
    created_by_username: row.created_by_username ? String(row.created_by_username) : null,
    created_at: String(row.created_at),
  };
}

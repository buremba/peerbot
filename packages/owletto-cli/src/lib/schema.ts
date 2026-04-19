/**
 * Owletto project YAML schema definitions.
 *
 * These types define the canonical format for project-local memory files:
 *   - owletto.yaml        — org-level config
 *   - models/*.y{a,}ml    — entity types, relationship types, watchers
 *   - data/(nested).yml   — seed entities and relationships
 *
 * Bump CURRENT_SCHEMA_VERSION when making breaking changes.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export type ModelType = 'entity' | 'relationship' | 'watcher';
export type DataRecordType = 'entity' | 'relationship';

// ── Project ─────────────────────────────────────────────────────────

export interface ProjectSchema {
  version?: number;
  org: string;
  name: string;
  description?: string;
  visibility?: 'public' | 'private';
}

// ── Model files ─────────────────────────────────────────────────────

export interface EntitySchema {
  version?: number;
  type: 'entity';
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  metadata_schema?: Record<string, unknown>;
}

export interface RelationshipSchema {
  version?: number;
  type: 'relationship';
  slug: string;
  name: string;
  description?: string;
}

export interface WatcherSchema {
  version?: number;
  type: 'watcher';
  slug: string;
  name: string;
  schedule: string;
  prompt: string;
  entity?: string;
  entity_id?: number;
  extraction_schema?: Record<string, unknown>;
  sources?: Array<{ name: string; query: string }>;
  reactions_guidance?: string;
}

export type ModelSchema = EntitySchema | RelationshipSchema | WatcherSchema;

// ── Seed data files ─────────────────────────────────────────────────

export interface SeedEntitySchema {
  version?: number;
  type: 'entity';
  entity_type: string;
  slug: string;
  name: string;
  content?: string;
  parent?: string;
  metadata?: Record<string, unknown>;
  enabled_classifiers?: string[];
}

export interface SeedRelationshipSchema {
  version?: number;
  type: 'relationship';
  relationship_type: string;
  from: string;
  to: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: 'ui' | 'llm' | 'feed' | 'api';
}

export type DataSchema = SeedEntitySchema | SeedRelationshipSchema;

// ── Validation ──────────────────────────────────────────────────────

export interface ValidationError {
  file: string;
  field: string;
  message: string;
}

function checkVersion(
  parsed: Record<string, unknown>,
  file: string,
  errors: ValidationError[]
): boolean {
  const v = parsed.version;
  if (v !== undefined && typeof v === 'number' && v > CURRENT_SCHEMA_VERSION) {
    errors.push({
      file,
      field: 'version',
      message: `version ${v} is not supported by this CLI (max: ${CURRENT_SCHEMA_VERSION}). Upgrade owletto.`,
    });
    return false;
  }
  return true;
}

function requireString(
  parsed: Record<string, unknown>,
  field: string,
  file: string,
  errors: ValidationError[]
): boolean {
  if (typeof parsed[field] !== 'string' || parsed[field] === '') {
    errors.push({ file, field, message: `"${field}" is required and must be a non-empty string` });
    return false;
  }
  return true;
}

function requireObject(
  parsed: Record<string, unknown>,
  field: string,
  file: string,
  errors: ValidationError[]
): boolean {
  const value = parsed[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ file, field, message: `"${field}" is required and must be an object` });
    return false;
  }
  return true;
}

export function validateProject(parsed: Record<string, unknown>, file: string): ValidationError[] {
  const errors: ValidationError[] = [];
  checkVersion(parsed, file, errors);
  requireString(parsed, 'org', file, errors);
  requireString(parsed, 'name', file, errors);

  if (
    parsed.visibility !== undefined &&
    parsed.visibility !== 'public' &&
    parsed.visibility !== 'private'
  ) {
    errors.push({
      file,
      field: 'visibility',
      message: '"visibility" must be one of: public, private',
    });
  }

  return errors;
}

export function validateModel(parsed: Record<string, unknown>, file: string): ValidationError[] {
  const errors: ValidationError[] = [];
  checkVersion(parsed, file, errors);

  const modelType = parsed.type as string | undefined;
  if (!modelType || !['entity', 'relationship', 'watcher'].includes(modelType)) {
    errors.push({
      file,
      field: 'type',
      message: `"type" is required and must be one of: entity, relationship, watcher`,
    });
    return errors;
  }

  requireString(parsed, 'slug', file, errors);
  requireString(parsed, 'name', file, errors);

  if (modelType === 'watcher') {
    requireString(parsed, 'schedule', file, errors);
    requireString(parsed, 'prompt', file, errors);
  }

  return errors;
}

export function validateDataRecord(
  parsed: Record<string, unknown>,
  file: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  checkVersion(parsed, file, errors);

  const recordType = parsed.type as string | undefined;
  if (!recordType || !['entity', 'relationship'].includes(recordType)) {
    errors.push({
      file,
      field: 'type',
      message: `"type" is required and must be one of: entity, relationship`,
    });
    return errors;
  }

  if (recordType === 'entity') {
    requireString(parsed, 'entity_type', file, errors);
    requireString(parsed, 'slug', file, errors);
    requireString(parsed, 'name', file, errors);
    if (parsed.metadata !== undefined) {
      requireObject(parsed, 'metadata', file, errors);
    }
    if (
      parsed.enabled_classifiers !== undefined &&
      !(
        Array.isArray(parsed.enabled_classifiers) &&
        parsed.enabled_classifiers.every((value) => typeof value === 'string')
      )
    ) {
      errors.push({
        file,
        field: 'enabled_classifiers',
        message: '"enabled_classifiers" must be an array of strings',
      });
    }
    return errors;
  }

  requireString(parsed, 'relationship_type', file, errors);
  requireString(parsed, 'from', file, errors);
  requireString(parsed, 'to', file, errors);
  if (parsed.metadata !== undefined) {
    requireObject(parsed, 'metadata', file, errors);
  }
  if (parsed.confidence !== undefined) {
    const confidence = parsed.confidence;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      errors.push({
        file,
        field: 'confidence',
        message: '"confidence" must be a number between 0 and 1',
      });
    }
  }
  if (
    parsed.source !== undefined &&
    !['ui', 'llm', 'feed', 'api'].includes(String(parsed.source))
  ) {
    errors.push({
      file,
      field: 'source',
      message: '"source" must be one of: ui, llm, feed, api',
    });
  }

  return errors;
}

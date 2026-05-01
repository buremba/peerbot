/**
 * Lobu memory project YAML schema definitions.
 *
 * These types define the canonical format for project-local memory files:
 *   - models/*.y{a,}ml    — entity types, relationship types, watchers
 *   - data/(nested).yml   — seed entities and relationships
 *
 * Project-level metadata (org/name/description/visibility) lives in
 * [memory.owletto] inside lobu.toml.
 *
 * Bump CURRENT_SCHEMA_VERSION when making breaking changes.
 */

import { AutoCreateWhenRule } from "@lobu/connector-sdk";
import { TypeCompiler } from "@sinclair/typebox/compiler";

export const CURRENT_SCHEMA_VERSION = 1;

export type ModelType = "entity" | "relationship" | "watcher";
export type DataRecordType = "entity" | "relationship";

// ── Model files ─────────────────────────────────────────────────────

export interface EntitySchema {
  version?: number;
  type: "entity";
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  metadata_schema?: Record<string, unknown>;
}

export interface RelationshipTypeRule {
  source: string;
  target: string;
}

export interface RelationshipSchema {
  version?: number;
  type: "relationship";
  slug: string;
  name: string;
  description?: string;
  /**
   * Allowed (source_entity_type, target_entity_type) pairs. When omitted, any
   * pair is permitted (backend `validateTypeRule` short-circuits if there are
   * no rules). Provide rules to constrain the relationship — especially for
   * cross-org references where unconstrained types would let any source
   * entity link to any target.
   */
  rules?: RelationshipTypeRule[];
  auto_create_when?: AutoCreateWhenRule[];
}

export interface WatcherSchema {
  version?: number;
  type: "watcher";
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
  type: "entity";
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
  type: "relationship";
  relationship_type: string;
  from: string;
  to: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: "ui" | "llm" | "feed" | "api";
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
  if (v !== undefined && typeof v === "number" && v > CURRENT_SCHEMA_VERSION) {
    errors.push({
      file,
      field: "version",
      message: `version ${v} is not supported by this CLI (max: ${CURRENT_SCHEMA_VERSION}). Upgrade @lobu/cli.`,
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
  if (typeof parsed[field] !== "string" || parsed[field] === "") {
    errors.push({
      file,
      field,
      message: `"${field}" is required and must be a non-empty string`,
    });
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({
      file,
      field,
      message: `"${field}" is required and must be an object`,
    });
    return false;
  }
  return true;
}

// Single source of truth for auto_create_when shape lives in
// `@lobu/connector-sdk`'s `AutoCreateWhenRule` schema. Compile once at module
// load and surface every TypeBox error as a ValidationError.
const compiledRule = TypeCompiler.Compile(AutoCreateWhenRule);

function validateAutoCreateWhenRules(
  value: unknown,
  file: string,
  errors: ValidationError[]
): void {
  if (!Array.isArray(value)) {
    errors.push({
      file,
      field: "auto_create_when",
      message: '"auto_create_when" must be an array of identity-engine rules',
    });
    return;
  }
  value.forEach((rule, idx) => {
    for (const err of compiledRule.Errors(rule)) {
      // TypeBox paths use JSON-Pointer slashes; translate to dot notation to
      // match the rest of this file's `field` style.
      errors.push({
        file,
        field: `auto_create_when[${idx}]${err.path.replaceAll("/", ".")}`,
        message: err.message,
      });
    }
  });
}

export function validateModel(
  parsed: Record<string, unknown>,
  file: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  checkVersion(parsed, file, errors);

  const modelType = parsed.type as string | undefined;
  if (
    !modelType ||
    !["entity", "relationship", "watcher"].includes(modelType)
  ) {
    errors.push({
      file,
      field: "type",
      message: `"type" is required and must be one of: entity, relationship, watcher`,
    });
    return errors;
  }

  requireString(parsed, "slug", file, errors);
  requireString(parsed, "name", file, errors);

  if (modelType === "watcher") {
    requireString(parsed, "schedule", file, errors);
    requireString(parsed, "prompt", file, errors);
  }

  if (modelType === "relationship" && parsed.auto_create_when !== undefined) {
    validateAutoCreateWhenRules(parsed.auto_create_when, file, errors);
  }

  if (modelType === "relationship" && parsed.rules !== undefined) {
    if (!Array.isArray(parsed.rules)) {
      errors.push({
        file,
        field: "rules",
        message: '"rules" must be an array of { source, target } pairs',
      });
    } else {
      parsed.rules.forEach((rule, idx) => {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
          errors.push({
            file,
            field: `rules[${idx}]`,
            message:
              'each rule must be an object with "source" and "target" string fields',
          });
          return;
        }
        const r = rule as Record<string, unknown>;
        if (typeof r.source !== "string" || r.source === "") {
          errors.push({
            file,
            field: `rules[${idx}].source`,
            message:
              '"source" is required and must be a non-empty entity-type slug',
          });
        }
        if (typeof r.target !== "string" || r.target === "") {
          errors.push({
            file,
            field: `rules[${idx}].target`,
            message:
              '"target" is required and must be a non-empty entity-type slug',
          });
        }
      });
    }
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
  if (!recordType || !["entity", "relationship"].includes(recordType)) {
    errors.push({
      file,
      field: "type",
      message: `"type" is required and must be one of: entity, relationship`,
    });
    return errors;
  }

  if (recordType === "entity") {
    requireString(parsed, "entity_type", file, errors);
    requireString(parsed, "slug", file, errors);
    requireString(parsed, "name", file, errors);
    if (parsed.metadata !== undefined) {
      requireObject(parsed, "metadata", file, errors);
    }
    if (
      parsed.enabled_classifiers !== undefined &&
      !(
        Array.isArray(parsed.enabled_classifiers) &&
        parsed.enabled_classifiers.every((value) => typeof value === "string")
      )
    ) {
      errors.push({
        file,
        field: "enabled_classifiers",
        message: '"enabled_classifiers" must be an array of strings',
      });
    }
    return errors;
  }

  requireString(parsed, "relationship_type", file, errors);
  requireString(parsed, "from", file, errors);
  requireString(parsed, "to", file, errors);
  if (parsed.metadata !== undefined) {
    requireObject(parsed, "metadata", file, errors);
  }
  if (parsed.confidence !== undefined) {
    const confidence = parsed.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      errors.push({
        file,
        field: "confidence",
        message: '"confidence" must be a number between 0 and 1',
      });
    }
  }
  if (
    parsed.source !== undefined &&
    !["ui", "llm", "feed", "api"].includes(String(parsed.source))
  ) {
    errors.push({
      file,
      field: "source",
      message: '"source" must be one of: ui, llm, feed, api',
    });
  }

  return errors;
}

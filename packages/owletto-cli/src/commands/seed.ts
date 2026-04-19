import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { parse as parseYaml } from 'yaml';
import { ApiError, ValidationError } from '../lib/errors.ts';
import {
  getSessionForOrg,
  getUsableToken,
  mcpUrlForOrg,
  orgFromMcpUrl,
  resolveOrg,
  resolveServerUrl,
} from '../lib/openclaw-auth.ts';
import { printError, printText } from '../lib/output.ts';
import {
  type DataRecordType,
  type ModelType,
  type ValidationError as SchemaError,
  type SeedEntitySchema,
  type SeedRelationshipSchema,
  validateDataRecord,
  validateModel,
  validateProject,
} from '../lib/schema.ts';

interface SeedContext {
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
  dryRun: boolean;
}

interface ParsedModel {
  data: Record<string, unknown>;
  file: string;
  modelType: ModelType;
}

interface ParsedDataRecord {
  data: Record<string, unknown>;
  file: string;
  recordType: DataRecordType;
}

interface ProjectLayout {
  projectRoot: string;
  projectPath: string;
  modelsPath: string;
  dataPath: string;
}

function readYamlFiles(dir: string): Array<{ data: Record<string, unknown>; file: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => ({
      data: parseYaml(readFileSync(resolve(dir, f), 'utf8')) as Record<string, unknown>,
      file: basename(f),
    }));
}

function readYamlFilesRecursive(
  dir: string,
  prefix = ''
): Array<{ data: Record<string, unknown>; file: string }> {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relPath = prefix ? join(prefix, entry.name) : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return readYamlFilesRecursive(fullPath, relPath);
      }
      if (!entry.isFile() || (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml'))) {
        return [];
      }
      return [
        {
          data: parseYaml(readFileSync(fullPath, 'utf8')) as Record<string, unknown>,
          file: relPath,
        },
      ];
    });
}

function checkErrors(errors: SchemaError[]): void {
  if (errors.length > 0) {
    for (const e of errors) {
      printError(`  ${e.file}: ${e.field} — ${e.message}`);
    }
    throw new ValidationError(
      `Schema validation failed (${errors.length} error${errors.length > 1 ? 's' : ''})`
    );
  }
}

function resolveProjectLayout(inputPath?: string): ProjectLayout {
  const requestedPath = resolve(inputPath || '.');

  if (existsSync(requestedPath) && basename(requestedPath) === 'owletto.yaml') {
    return {
      projectRoot: dirname(requestedPath),
      projectPath: requestedPath,
      modelsPath: join(dirname(requestedPath), 'models'),
      dataPath: join(dirname(requestedPath), 'data'),
    };
  }

  const projectPath = join(requestedPath, 'owletto.yaml');
  if (!existsSync(projectPath)) {
    throw new ValidationError(`Could not find owletto project config at ${projectPath}`);
  }
  return {
    projectRoot: requestedPath,
    projectPath,
    modelsPath: join(requestedPath, 'models'),
    dataPath: join(requestedPath, 'data'),
  };
}

/**
 * Load models from the `models/` directory (type in each file).
 */
function loadModels(modelsPath: string): ParsedModel[] {
  const entries = readYamlFiles(modelsPath);
  for (const { data, file } of entries) {
    checkErrors(validateModel(data, file));
  }
  return entries.map(({ data, file }) => ({
    data,
    file,
    modelType: data.type as ModelType,
  }));
}

function loadDataRecords(dataPath: string): ParsedDataRecord[] {
  const entries = readYamlFilesRecursive(dataPath);
  for (const { data, file } of entries) {
    checkErrors(validateDataRecord(data, file));
  }
  return entries.map(({ data, file }) => ({
    data,
    file,
    recordType: data.type as DataRecordType,
  }));
}

function deriveApiBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

async function callTool(
  ctx: SeedContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${ctx.apiBaseUrl}/api/${ctx.orgSlug}/${toolName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.token}`,
    },
    body: JSON.stringify(args),
  });

  const body = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new ApiError(`Invalid JSON from ${toolName}: ${body}`, res.status);
  }

  if (!res.ok) {
    const msg = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }

  return parsed;
}

async function seedEntity(entity: Record<string, unknown>, ctx: SeedContext): Promise<void> {
  const slug = entity.slug as string;
  if (ctx.dryRun) {
    printText(`  [dry-run] would create entity_type: ${slug}`);
    return;
  }
  try {
    await callTool(ctx, 'manage_entity_schema', {
      schema_type: 'entity_type',
      action: 'create',
      ...entity,
    });
    printText(`  + entity_type: ${slug}`);
  } catch (e) {
    if (e instanceof Error && e.message?.includes('already exists')) {
      printText(`  = entity_type: ${slug} (exists)`);
    } else {
      throw e;
    }
  }
}

async function seedRelationshipType(rel: Record<string, unknown>, ctx: SeedContext): Promise<void> {
  const slug = rel.slug as string;
  if (ctx.dryRun) {
    printText(`  [dry-run] would create relationship_type: ${slug}`);
    return;
  }
  try {
    await callTool(ctx, 'manage_entity_schema', {
      schema_type: 'relationship_type',
      action: 'create',
      ...rel,
    });
    printText(`  + relationship_type: ${slug}`);
  } catch (e) {
    if (e instanceof Error && e.message?.includes('already exists')) {
      printText(`  = relationship_type: ${slug} (exists)`);
    } else {
      throw e;
    }
  }
}

function addEntityRef(
  entityMap: Map<string, number>,
  entity: { id: number; slug: string; entity_type: string }
) {
  entityMap.set(entity.slug, entity.id);
  entityMap.set(`${entity.entity_type}:${entity.slug}`, entity.id);
}

function resolveEntityRef(entityMap: Map<string, number>, ref: string): number | null {
  return entityMap.get(ref) ?? null;
}

async function loadEntityMap(
  ctx: SeedContext,
  entityTypes: string[]
): Promise<Map<string, number>> {
  const entityMap = new Map<string, number>();
  const uniqueTypes = Array.from(new Set(entityTypes.filter(Boolean))).sort();
  const PAGE_SIZE = 500;

  for (const entityType of uniqueTypes) {
    let offset = 0;
    while (true) {
      const result = await callTool(ctx, 'manage_entity', {
        action: 'list',
        entity_type: entityType,
        limit: PAGE_SIZE,
        offset,
      });
      const entities = (result.entities || []) as Array<{
        id: number;
        slug: string;
        entity_type: string;
      }>;
      for (const entity of entities) {
        addEntityRef(entityMap, entity);
      }
      if (entities.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return entityMap;
}

async function seedDataEntity(
  entity: SeedEntitySchema,
  entityMap: Map<string, number>,
  ctx: SeedContext
): Promise<boolean> {
  if (ctx.dryRun) {
    if (entity.parent && !resolveEntityRef(entityMap, entity.parent)) {
      printError(`  ! entity: ${entity.slug} - unknown parent "${entity.parent}", will retry`);
      return false;
    }
    const placeholderId = -(entityMap.size + 1);
    addEntityRef(entityMap, {
      id: placeholderId,
      slug: entity.slug,
      entity_type: entity.entity_type,
    });
    printText(`  [dry-run] would create entity: ${entity.slug}`);
    return true;
  }

  const payload: Record<string, unknown> = {
    action: 'create',
    entity_type: entity.entity_type,
    slug: entity.slug,
    name: entity.name,
  };
  if (entity.content) payload.content = entity.content;
  if (entity.metadata) payload.metadata = entity.metadata;
  if (entity.enabled_classifiers) payload.enabled_classifiers = entity.enabled_classifiers;
  if (entity.parent) {
    const parentId = resolveEntityRef(entityMap, entity.parent);
    if (!parentId) {
      printError(`  ! entity: ${entity.slug} - unknown parent "${entity.parent}", will retry`);
      return false;
    }
    payload.parent_id = parentId;
  }

  try {
    const result = await callTool(ctx, 'manage_entity', payload);
    const created = result.entity as { id: number; slug: string; entity_type: string } | undefined;
    if (created) {
      addEntityRef(entityMap, created);
    }
    printText(`  + entity: ${entity.slug}`);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message?.includes('already exists')) {
      printText(`  = entity: ${entity.slug} (exists)`);
      return true;
    }
    throw e;
  }
}

async function seedDataRelationship(
  relationship: SeedRelationshipSchema,
  entityMap: Map<string, number>,
  ctx: SeedContext
): Promise<boolean> {
  const fromId = resolveEntityRef(entityMap, relationship.from);
  const toId = resolveEntityRef(entityMap, relationship.to);
  if (!fromId || !toId) {
    printError(
      `  ! relationship: ${relationship.relationship_type} - unresolved refs from="${relationship.from}" to="${relationship.to}", skipping`
    );
    return false;
  }

  if (ctx.dryRun) {
    printText(
      `  [dry-run] would create relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to})`
    );
    return true;
  }

  try {
    await callTool(ctx, 'manage_entity', {
      action: 'link',
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: relationship.relationship_type,
      ...(relationship.metadata ? { metadata: relationship.metadata } : {}),
      ...(relationship.confidence !== undefined ? { confidence: relationship.confidence } : {}),
      ...(relationship.source ? { source: relationship.source } : {}),
    });
    printText(
      `  + relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to})`
    );
    return true;
  } catch (e) {
    if (e instanceof Error && e.message?.includes('already exists')) {
      printText(
        `  = relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to}) (exists)`
      );
      return true;
    }
    throw e;
  }
}

async function seedWatcher(
  watcher: Record<string, unknown>,
  entityMap: Map<string, number>,
  ctx: SeedContext
): Promise<void> {
  const payload = { ...watcher };
  const slug = payload.slug as string;

  if (typeof payload.entity === 'string') {
    const entityId = resolveEntityRef(entityMap, payload.entity);
    if (entityId) {
      payload.entity_id = entityId;
    } else {
      printError(`  ! watcher: ${slug} - unknown entity ref "${payload.entity}", skipping`);
      return;
    }
    delete payload.entity;
  }

  if (!payload.entity_id) {
    const fallbackEntityId = entityMap.values().next().value as number | undefined;
    if (fallbackEntityId) {
      payload.entity_id = fallbackEntityId;
      printText(
        `  ~ watcher: ${slug} - no entity specified, using first seeded entity (${fallbackEntityId})`
      );
    }
  }

  if (!payload.entity_id) {
    printError(`  ! watcher: ${slug} - no entity_id available, skipping`);
    return;
  }

  if (ctx.dryRun) {
    printText(`  [dry-run] would create watcher: ${slug}`);
    return;
  }

  try {
    await callTool(ctx, 'manage_watchers', {
      action: 'create',
      ...payload,
    });
    printText(`  + watcher: ${slug}`);
  } catch (e) {
    if (e instanceof Error && e.message?.includes('already exists')) {
      printText(`  = watcher: ${slug} (exists)`);
    } else {
      throw e;
    }
  }
}

async function resolveAuth(
  urlFlag?: string,
  orgFlag?: string,
  storePath?: string
): Promise<{ token: string; mcpUrl: string; orgSlug: string }> {
  const org = resolveOrg(orgFlag);

  if (org) {
    const orgSession = getSessionForOrg(org, storePath);
    if (orgSession) {
      const result = await getUsableToken(orgSession.key, storePath);
      if (result) {
        return { token: result.token, mcpUrl: orgSession.key, orgSlug: org };
      }
    }
    const serverUrl = resolveServerUrl(urlFlag, storePath);
    if (serverUrl) {
      const orgUrl = mcpUrlForOrg(serverUrl, org);
      const result = await getUsableToken(orgUrl, storePath);
      if (result) {
        return { token: result.token, mcpUrl: orgUrl, orgSlug: org };
      }
    }
    throw new ValidationError(
      `No session for org "${org}". Run: owletto login <server-url>/mcp/${org}`
    );
  }

  const serverUrl = resolveServerUrl(urlFlag, storePath);
  const result = await getUsableToken(serverUrl || undefined, storePath);
  if (!result) {
    throw new ValidationError('No active session. Run: owletto login');
  }

  const resolvedOrg = orgFromMcpUrl(result.session.mcpUrl) || result.session.org;
  if (!resolvedOrg) {
    throw new ValidationError(
      'Cannot determine org from session. Use --org flag or set OWLETTO_ORG.'
    );
  }

  return { token: result.token, mcpUrl: result.session.mcpUrl, orgSlug: resolvedOrg };
}

export default defineCommand({
  meta: {
    name: 'seed',
    description: 'Provision an Owletto workspace from owletto.yaml + models/ + optional data/',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Project root or path to owletto.yaml (default: current directory).',
      required: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Log what would be created without mutating',
      alias: 'dry-run',
    },
    org: {
      type: 'string',
      description: 'Organization slug (overrides owletto.yaml / project.yaml and session default)',
    },
    url: {
      type: 'string',
      description: 'Server URL (overrides OWLETTO_URL / active session)',
    },
    storePath: {
      type: 'string',
      description: 'Custom auth store path',
    },
  },
  async run({ args }) {
    const layout = resolveProjectLayout(args.path);
    const project = parseYaml(readFileSync(layout.projectPath, 'utf8')) as Record<string, unknown>;
    checkErrors(validateProject(project, basename(layout.projectPath)));

    const orgOverride = args.org || (project.org as string | undefined);
    const { token, mcpUrl, orgSlug } = await resolveAuth(args.url, orgOverride, args.storePath);
    const apiBaseUrl = deriveApiBaseUrl(mcpUrl);
    const dryRun = args.dryRun ?? false;
    const ctx: SeedContext = { apiBaseUrl, orgSlug, token, dryRun };

    printText(`Seeding org: ${orgSlug}${dryRun ? ' (dry-run)' : ''}`);
    printText(`Config: ${layout.projectPath}`);
    if (project.name) {
      printText(`Project: ${project.name as string}`);
    }
    const models = loadModels(layout.modelsPath);
    const dataRecords = loadDataRecords(layout.dataPath);

    const entityTypes = models.filter((m) => m.modelType === 'entity');
    const relationshipTypes = models.filter((m) => m.modelType === 'relationship');
    const watchers = models.filter((m) => m.modelType === 'watcher');
    const dataEntities = dataRecords.filter(
      (record): record is ParsedDataRecord & { data: SeedEntitySchema } =>
        record.recordType === 'entity'
    );
    const dataRelationships = dataRecords.filter(
      (record): record is ParsedDataRecord & { data: SeedRelationshipSchema } =>
        record.recordType === 'relationship'
    );

    if (entityTypes.length > 0) {
      printText(`\nEntity types (${entityTypes.length}):`);
      for (const { data } of entityTypes) {
        await seedEntity(data, ctx);
      }
    }

    if (relationshipTypes.length > 0) {
      printText(`\nRelationship types (${relationshipTypes.length}):`);
      for (const { data } of relationshipTypes) {
        await seedRelationshipType(data, ctx);
      }
    }

    const entityTypesForLookup = Array.from(
      new Set([
        ...entityTypes.map((entry) => String(entry.data.slug || '')),
        ...dataEntities.map((entry) => entry.data.entity_type),
      ])
    );
    const entityMap = dryRun
      ? new Map<string, number>()
      : await loadEntityMap(ctx, entityTypesForLookup);

    if (dataEntities.length > 0) {
      printText(`\nData entities (${dataEntities.length}):`);
      let pending = [...dataEntities];
      let previousPendingCount = Number.POSITIVE_INFINITY;
      while (pending.length > 0 && pending.length < previousPendingCount) {
        previousPendingCount = pending.length;
        const nextPending: typeof pending = [];
        for (const entry of pending) {
          const resolved = await seedDataEntity(entry.data, entityMap, ctx);
          if (!resolved) {
            nextPending.push(entry);
          }
        }
        pending = nextPending;
      }
      for (const entry of pending) {
        printError(`  ! entity: ${entry.data.slug} - could not resolve dependencies, skipped`);
      }
    }

    if (dataRelationships.length > 0) {
      printText(`\nData relationships (${dataRelationships.length}):`);
      for (const entry of dataRelationships) {
        await seedDataRelationship(entry.data, entityMap, ctx);
      }
    }

    if (watchers.length > 0) {
      printText(`\nWatchers (${watchers.length}):`);
      for (const { data } of watchers) {
        await seedWatcher(data, entityMap, ctx);
      }
    }

    printText(dryRun ? '\nDry run complete.' : '\nSeed complete.');
  },
});

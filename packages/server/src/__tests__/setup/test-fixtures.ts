/**
 * Test Fixtures
 *
 * Factory functions for creating test data in the database.
 * Each function creates the necessary records and returns the relevant IDs.
 */

import { serializeSigned } from 'hono/utils/cookie';
import { generateSecureToken, hashToken } from '../../auth/oauth/utils';
import { pgTextArray } from '../../db/client';
import { nextRunAt } from '../../utils/cron';
import { generateSlug } from '../../utils/entity-management';
import { getTestDb } from './test-db';

/** Format a JS number array as a PostgreSQL bigint[] literal. */
function pgBigintArray(values: number[]): string {
  return '{' + values.map((v) => String(Math.trunc(v))).join(',') + '}';
}

const TEST_SYSTEM_ORG_ID = 'default';
const TEST_AUTH_SECRET = 'test-auth-secret-for-testing-only';

// ============================================
// Organization Fixtures
// ============================================

export interface TestOrganization {
  id: string;
  name: string;
  slug: string;
}

export async function createTestOrganization(options?: {
  name?: string;
  slug?: string;
  description?: string | null;
  logo?: string | null;
  visibility?: 'public' | 'private';
}): Promise<TestOrganization> {
  const sql = getTestDb();
  const id = `org_${generateSecureToken(8)}`;
  const name = options?.name || `Test Org ${id.slice(4, 12)}`;
  const slug = options?.slug || `test-org-${id.slice(4, 12)}`;

  await sql`
    INSERT INTO "organization" (id, name, slug, description, logo, visibility, "createdAt")
    VALUES (
      ${id},
      ${name},
      ${slug},
      ${options?.description ?? null},
      ${options?.logo ?? null},
      ${options?.visibility ?? 'private'},
      NOW()
    )
  `;

  return { id, name, slug };
}

// ============================================
// User Fixtures
// ============================================

export interface TestUser {
  id: string;
  email: string;
  name: string;
  username: string;
}

interface TestAgent {
  agentId: string;
  organizationId: string;
  name: string;
}

export async function createTestUser(options?: {
  email?: string;
  name?: string;
  username?: string;
}): Promise<TestUser> {
  const sql = getTestDb();
  const id = `user_${generateSecureToken(8)}`;
  const email = options?.email || `${id.slice(5, 13)}@test.example.com`;
  const name = options?.name || `Test User ${id.slice(5, 13)}`;
  const baseUsername =
    options?.username ||
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '');
  const username =
    baseUsername.length > 0 ? `${baseUsername}-${id.slice(5, 9)}` : `user-${id.slice(5, 9)}`;

  await sql`
    INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${email}, ${name}, ${username}, true, NOW(), NOW())
  `;

  return { id, email, name, username };
}

export async function addUserToOrganization(
  userId: string,
  organizationId: string,
  role: string = 'member'
): Promise<string> {
  const sql = getTestDb();
  const memberId = `member_${generateSecureToken(8)}`;

  await sql`
    INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
    VALUES (${memberId}, ${userId}, ${organizationId}, ${role}, NOW())
  `;

  return memberId;
}

export async function createTestAgent(options: {
  organizationId: string;
  agentId?: string;
  name?: string;
  description?: string | null;
  ownerUserId?: string;
}): Promise<TestAgent> {
  const sql = getTestDb();
  const agentId = options.agentId ?? `agent-${generateSecureToken(8).toLowerCase()}`;
  const name = options.name ?? `Test Agent ${agentId.slice(-4)}`;
  const ownerUserId = options.ownerUserId ?? `user_${generateSecureToken(8)}`;

  await sql`
    INSERT INTO agents (
      id,
      organization_id,
      name,
      description,
      owner_platform,
      owner_user_id,
      is_workspace_agent,
      created_at,
      updated_at
    ) VALUES (
      ${agentId},
      ${options.organizationId},
      ${name},
      ${options.description ?? null},
      'owletto',
      ${ownerUserId},
      false,
      NOW(),
      NOW()
    )
  `;

  return { agentId, organizationId: options.organizationId, name };
}

// ============================================
// Entity Fixtures
// ============================================

interface TestEntity {
  id: number;
  name: string;
  entity_type: string;
  organization_id: string;
}

/**
 * Re-seed system entity types after cleanupTestDatabase() truncates them.
 * Must be called in beforeAll if tests use manage_entity (which validates entity_type).
 */
export async function seedSystemEntityTypes(): Promise<void> {
  const sql = getTestDb();

  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${TEST_SYSTEM_ORG_ID}, 'Owletto System', 'public-owletto', NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Brand gets a typed schema so metadata-validation tests can verify constraints
  const brandSchema = JSON.stringify({
    type: 'object',
    properties: {
      industry: { type: 'string' },
      founded_year: { type: 'number' },
      headquarters: { type: 'string' },
      website: { type: 'string' },
      domain: { type: 'string' },
      category: { type: 'string' },
    },
    additionalProperties: true,
  });

  const types: [string, string, string, string, string][] = [
    ['brand', 'Brand', 'A company, product line, or brand identity', '🏢', brandSchema],
    ['product', 'Product', 'A specific product, app, or service', '📦', '{}'],
    ['competitor', 'Competitor', 'A competing brand or product', '🎯', '{}'],
    ['feature', 'Feature', 'A product feature or capability', '✨', '{}'],
    ['campaign', 'Campaign', 'A marketing campaign or initiative', '📢', '{}'],
    ['topic', 'Topic', 'A subject area or theme to monitor', '💡', '{}'],
  ];

  for (const [slug, name, description, icon, schema] of types) {
    const existing = await sql`
      SELECT id
      FROM entity_types
      WHERE slug = ${slug}
        AND organization_id = ${TEST_SYSTEM_ORG_ID}
      LIMIT 1
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO entity_types (
          organization_id,
          slug,
          name,
          description,
          icon,
          metadata_schema,
          created_at,
          updated_at
        )
        VALUES (
          ${TEST_SYSTEM_ORG_ID},
          ${slug},
          ${name},
          ${description},
          ${icon},
          ${sql.json(JSON.parse(schema))},
          current_timestamp,
          current_timestamp
        )
      `;
    } else {
      // Always refresh the schema in case a prior test run used an empty one
      await sql`
        UPDATE entity_types
        SET metadata_schema = ${sql.json(JSON.parse(schema))}
        WHERE slug = ${slug}
          AND organization_id = ${TEST_SYSTEM_ORG_ID}
      `;
    }
  }
}

export async function createTestEntity(options: {
  name: string;
  entity_type?: string;
  organization_id: string;
  parent_id?: number;
  domain?: string;
  created_by?: string;
}): Promise<TestEntity> {
  const sql = getTestDb();
  const slug = generateSlug(options.name);
  const metadata = options.domain ? { domain: options.domain } : {};

  // Resolve created_by: use provided user ID or find any existing user in the org
  let createdBy = options.created_by;
  if (!createdBy) {
    const members = await sql`
      SELECT "userId" FROM "member" WHERE "organizationId" = ${options.organization_id} LIMIT 1
    `;
    if (members.length > 0) {
      createdBy = members[0].userId as string;
    } else {
      createdBy = 'test-seed-user';
      await sql`
        INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
        VALUES (${createdBy}, 'Test Seed User', 'test-seed-user@example.com', 'test-seed-user', true, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  // Tests routinely create entities in fresh orgs without first calling
  // seedSystemEntityTypes(); ensure the requested type exists so the FK
  // (entities.entity_type_id) resolves without forcing every test to seed.
  const entityTypeSlug = options.entity_type || 'brand';
  let typeRows = await sql<{ id: number }[]>`
    SELECT id FROM entity_types
    WHERE slug = ${entityTypeSlug}
      AND organization_id = ${options.organization_id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (typeRows.length === 0) {
    typeRows = await sql<{ id: number }[]>`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${options.organization_id}, ${entityTypeSlug}, ${entityTypeSlug}, current_timestamp, current_timestamp)
      RETURNING id
    `;
  }
  const entityTypeId = typeRows[0].id;

  const [inserted] = await sql`
    INSERT INTO entities (
      name,
      slug,
      entity_type_id,
      organization_id,
      parent_id,
      metadata,
      created_by,
      created_at,
      updated_at
    ) VALUES (
      ${options.name},
      ${slug},
      ${entityTypeId},
      ${options.organization_id},
      ${options.parent_id || null},
      ${sql.json(metadata)},
      ${createdBy},
      NOW(), NOW()
    )
    RETURNING id
  `;

  return {
    id: Number(inserted.id),
    name: options.name,
    entity_type: options.entity_type || 'brand',
    organization_id: options.organization_id,
  };
}

// ============================================
// OAuth Client Fixtures
// ============================================

export interface TestOAuthClient {
  client_id: string;
  client_secret: string; // Plaintext for testing
  redirect_uris: string[];
}

export async function createTestOAuthClient(options?: {
  redirect_uris?: string[];
  client_name?: string | null;
  grant_types?: string[];
  software_id?: string | null;
  software_version?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<TestOAuthClient> {
  const sql = getTestDb();
  const client_id = `mcp_${generateSecureToken(16)}`;
  const client_secret = `secret_${generateSecureToken(32)}`;
  const redirect_uris = options?.redirect_uris || ['http://localhost:3000/callback'];
  const grant_types = options?.grant_types || ['authorization_code', 'refresh_token'];
  const clientName =
    options && Object.hasOwn(options, 'client_name')
      ? (options.client_name ?? null)
      : 'Test Client';

  await sql`
    INSERT INTO oauth_clients (
      id, client_secret, redirect_uris, grant_types, response_types,
      token_endpoint_auth_method, client_name, software_id, software_version, metadata, created_at, updated_at
    ) VALUES (
      ${client_id},
      ${hashToken(client_secret)},
      ${pgTextArray(redirect_uris)}::text[],
      ${pgTextArray(grant_types)}::text[],
      ${pgTextArray(['code'])}::text[],
      'client_secret_post',
      ${clientName},
      ${options?.software_id ?? null},
      ${options?.software_version ?? null},
      ${sql.json((options?.metadata || {}) as Record<string, string>)},
      NOW(), NOW()
    )
  `;

  return { client_id, client_secret, redirect_uris };
}

// ============================================
// Token Fixtures
// ============================================

interface TestAccessToken {
  token: string;
  userId: string;
  organizationId: string;
}

export async function createTestAccessToken(
  userId: string,
  organizationId: string,
  clientId: string,
  options?: {
    expiresIn?: number; // seconds
    scope?: string;
  }
): Promise<TestAccessToken> {
  const sql = getTestDb();
  const token = generateSecureToken(32);
  const tokenHash = hashToken(token);
  const id = generateSecureToken(16);
  const expiresAt = new Date(Date.now() + (options?.expiresIn || 3600) * 1000);

  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      scope, expires_at, created_at
    ) VALUES (
      ${id}, 'access', ${tokenHash}, ${clientId}, ${userId}, ${organizationId},
      ${options?.scope || 'mcp:read mcp:write'}, ${expiresAt}, NOW()
    )
  `;

  return { token, userId, organizationId };
}

export async function createExpiredAccessToken(
  userId: string,
  organizationId: string,
  clientId: string
): Promise<TestAccessToken> {
  const sql = getTestDb();
  const token = generateSecureToken(32);
  const tokenHash = hashToken(token);
  const id = generateSecureToken(16);
  const expiresAt = new Date(Date.now() - 3600 * 1000); // Expired 1 hour ago

  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      scope, expires_at, created_at
    ) VALUES (
      ${id}, 'access', ${tokenHash}, ${clientId}, ${userId}, ${organizationId},
      'mcp:read mcp:write', ${expiresAt}, NOW() - INTERVAL '2 hours'
    )
  `;

  return { token, userId, organizationId };
}

// ============================================
// Personal Access Token Fixtures
// ============================================

interface TestPAT {
  token: string;
  userId: string;
  organizationId: string;
}

export async function createTestPAT(userId: string, organizationId: string): Promise<TestPAT> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12);

  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId}, 'Test PAT', NOW(), NOW()
    )
  `;

  return { token, userId, organizationId };
}

// ============================================
// Connector Definition Fixtures
// ============================================

interface TestConnectorDefinition {
  key: string;
  name: string;
}

export async function createTestConnectorDefinition(options: {
  key: string;
  name: string;
  version?: string;
  feeds_schema?: Record<string, any>;
  auth_schema?: Record<string, any>;
  organization_id?: string | null;
  entity_link_overrides?: Record<string, any> | null;
}): Promise<TestConnectorDefinition> {
  const sql = getTestDb();
  const version = options.version ?? '1.0.0';

  await sql`
    INSERT INTO connector_definitions (
      key, name, version, feeds_schema, auth_schema,
      organization_id, entity_link_overrides,
      status, created_at, updated_at
    ) VALUES (
      ${options.key},
      ${options.name},
      ${version},
      ${sql.json(options.feeds_schema ?? { default: {} })},
      ${sql.json(options.auth_schema ?? {})},
      ${options.organization_id ?? null},
      ${options.entity_link_overrides ? sql.json(options.entity_link_overrides) : null},
      'active',
      NOW(), NOW()
    )
  `;

  // Also insert a connector_versions row so trigger_feed / createSyncRun can find compiled code
  await sql`
    INSERT INTO connector_versions (
      connector_key, version, compiled_code, created_at
    ) VALUES (
      ${options.key},
      ${version},
      ${'module.exports = { sync: async () => ({ items: [] }) }'},
      NOW()
    )
    ON CONFLICT DO NOTHING
  `;

  return { key: options.key, name: options.name };
}

// ============================================
// Connection Fixtures
// ============================================

interface TestConnection {
  id: number;
  connector_key: string;
  status: string;
}

export async function createTestConnection(options: {
  organization_id: string;
  connector_key: string;
  entity_ids?: number[];
  status?: string;
  display_name?: string;
  created_by?: string;
  visibility?: 'org' | 'private';
}): Promise<TestConnection> {
  const sql = getTestDb();

  const entityIdsLiteral = options.entity_ids ? pgBigintArray(options.entity_ids) : null;
  const [inserted] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, display_name, status,
      created_by, visibility, created_at, updated_at
    ) VALUES (
      ${options.organization_id},
      ${options.connector_key},
      ${options.display_name ?? `Test Connection ${options.connector_key}`},
      ${options.status ?? 'active'},
      ${options.created_by ?? null},
      ${options.visibility ?? 'org'},
      NOW(), NOW()
    )
    RETURNING id, connector_key, status
  `;

  await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, entity_ids, created_at, updated_at
    ) VALUES (
      ${options.organization_id},
      ${inserted.id},
      'default',
      ${options.status ?? 'active'},
      ${entityIdsLiteral}::bigint[],
      NOW(),
      NOW()
    )
  `;

  return {
    id: Number(inserted.id),
    connector_key: String(inserted.connector_key),
    status: String(inserted.status),
  };
}

// ============================================
// Event Fixtures
// ============================================

interface TestEvent {
  id: number;
  origin_id: string;
}

export async function createTestEvent(options: {
  entity_id?: number;
  connection_id?: number;
  feed_id?: number;
  title?: string;
  content: string;
  occurred_at?: Date;
  origin_id?: string;
  embedding?: number[];
  semantic_type?: string;
  connector_key?: string;
  entity_ids?: number[];
  organization_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<TestEvent> {
  const sql = getTestDb();
  const originId = options.origin_id ?? `test-event-${generateSecureToken(8)}`;
  const resolvedEntityIds =
    options.entity_ids ?? (options.entity_id != null ? [options.entity_id] : []);
  const entityIdsLiteral = pgBigintArray(resolvedEntityIds);

  // Resolve organization_id from the first entity if not provided
  let organizationId = options.organization_id ?? null;
  if (!organizationId && resolvedEntityIds.length > 0) {
    const entityRow =
      await sql`SELECT organization_id FROM entities WHERE id = ${resolvedEntityIds[0]}`;
    if (entityRow.length > 0) organizationId = entityRow[0].organization_id as string;
  }

  let inserted: any;
  [inserted] = await sql`
    INSERT INTO events (
      entity_ids, connection_id, feed_id, origin_id,
      title, payload_type, payload_text, occurred_at, semantic_type,
      connector_key, metadata,
      organization_id, created_at
    ) VALUES (
      ${entityIdsLiteral}::bigint[],
      ${options.connection_id ?? null},
      ${options.feed_id ?? null},
      ${originId},
      ${options.title ?? null},
      'text',
      ${options.content},
      ${options.occurred_at ?? new Date()},
      ${options.semantic_type ?? 'content'},
      ${options.connector_key ?? 'test.connector'},
      ${sql.json((options.metadata ?? {}) as Record<string, string>)},
      ${organizationId},
      NOW()
    )
    RETURNING id, origin_id
  `;

  if (options.embedding) {
    await sql`
      INSERT INTO event_embeddings (event_id, embedding)
      VALUES (${inserted.id}, ${JSON.stringify(options.embedding)}::vector)
    `;
  }

  return {
    id: Number(inserted.id),
    origin_id: String(inserted.origin_id),
  };
}

// ============================================
// Watcher + Version Fixtures
// ============================================

interface TestWatcherTemplate {
  id: string;
  slug: string;
}

export async function createTestWatcherTemplate(options: {
  slug: string;
  name: string;
  version?: number;
  prompt?: string;
  output_schema?: Record<string, any>;
  organization_id?: string | null;
  entity_id?: number;
}): Promise<TestWatcherTemplate> {
  const sql = getTestDb();

  // Ensure seed user exists for FK constraint
  await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES ('test-seed-user', 'Test Seed User', 'test-seed-user@example.com', 'test-seed-user', true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Create the watcher row
  const [{ next_id }] = await sql`
    SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM watchers
  `;

  const entityIds = options.entity_id ? `{${options.entity_id}}` : null;

  const [inserted] = await sql`
    INSERT INTO watchers (
      id, slug, name, description,
      organization_id, created_by,
      entity_ids, version, status,
      created_at, updated_at
    ) VALUES (
      ${next_id},
      ${options.slug},
      ${options.name},
      ${'Test watcher'},
      ${options.organization_id ?? null},
      'test-seed-user',
      ${entityIds ? sql`${entityIds}::bigint[]` : null},
      ${options.version ?? 1},
      'active',
      NOW(), NOW()
    )
    RETURNING id, slug
  `;

  const watcherId = Number(inserted.id);

  // Create a version for this watcher
  const [{ next_vid }] = await sql`
    SELECT COALESCE(MAX(id), 0) + 1 AS next_vid FROM watcher_versions
  `;

  const [versionRow] = await sql`
    INSERT INTO watcher_versions (
      id, watcher_id, version, name, description, prompt,
      extraction_schema, change_notes,
      created_by, created_at
    ) VALUES (
      ${next_vid},
      ${watcherId},
      ${options.version ?? 1},
      ${options.name},
      ${'Test watcher'},
      ${options.prompt ?? 'Analyze the content for {{entities}}'},
      ${sql.json(options.output_schema ?? { type: 'object', properties: { summary: { type: 'string' } } })},
      'Initial version',
      'test-seed-user',
      NOW()
    )
    RETURNING id
  `;

  // Set current version ID
  await sql`
    UPDATE watchers
    SET current_version_id = ${versionRow.id}
    WHERE id = ${watcherId}
  `;

  return {
    id: String(watcherId),
    slug: options.slug,
  };
}

// ============================================
// Watcher Fixtures (attach entity to existing watcher)
// ============================================

interface TestWatcher {
  id: number;
  entity_id: number;
  version_id: number;
}

export async function createTestWatcher(options: {
  entity_id: number;
  template_id: string;
  organization_id: string;
  status?: string;
  schedule?: string;
  agent_id?: string;
  scheduler_client_id?: string;
  filters?: Record<string, any>;
}): Promise<TestWatcher> {
  const sql = getTestDb();

  const watcherId = Number(options.template_id);

  // Update the watcher to attach the entity and set options
  await sql`
    UPDATE watchers
    SET entity_ids = ${`{${options.entity_id}}`}::bigint[],
        organization_id = ${options.organization_id},
        status = ${options.status ?? 'active'},
        schedule = ${options.schedule ?? null},
        next_run_at = ${options.schedule ? nextRunAt(options.schedule) : null},
        agent_id = ${options.agent_id ?? null},
        scheduler_client_id = ${options.scheduler_client_id ?? null},
        updated_at = NOW()
    WHERE id = ${watcherId}
  `;

  // Get current version id
  const [w] = await sql`
    SELECT current_version_id FROM watchers WHERE id = ${watcherId} LIMIT 1
  `;

  return {
    id: watcherId,
    entity_id: options.entity_id,
    version_id: Number(w.current_version_id),
  };
}

// ============================================
// Watcher Window Fixtures
// ============================================

interface TestWatcherWindow {
  id: number;
  watcher_id: number;
}

export async function createTestWatcherWindow(options: {
  watcher_id: number;
  window_start?: Date;
  window_end?: Date;
  granularity?: string;
  extracted_data?: Record<string, any>;
  content_analyzed?: number;
  model_used?: string;
  client_id?: string;
  run_metadata?: Record<string, any>;
}): Promise<TestWatcherWindow> {
  const sql = getTestDb();
  const windowStart = options.window_start ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const windowEnd = options.window_end ?? new Date();

  const [inserted] = await sql`
    INSERT INTO watcher_windows (
      watcher_id, granularity, window_start, window_end,
      extracted_data, content_analyzed, model_used, client_id, run_metadata, created_at
    ) VALUES (
      ${options.watcher_id},
      ${options.granularity ?? 'weekly'},
      ${windowStart},
      ${windowEnd},
      ${sql.json(options.extracted_data ?? { summary: 'Test summary' })},
      ${options.content_analyzed ?? 10},
      ${options.model_used ?? 'test-model'},
      ${options.client_id ?? null},
      ${sql.json(options.run_metadata ?? {})},
      NOW()
    )
    RETURNING id, watcher_id
  `;

  return {
    id: Number(inserted.id),
    watcher_id: Number(inserted.watcher_id),
  };
}

// ============================================
// Action Run Fixtures
// ============================================

interface TestActionRun {
  id: number;
  connection_id: number;
  status: string;
}

export async function createTestActionRun(options: {
  connection_id: number;
  organization_id: string;
  action_key: string;
  status?: string;
  approval_status?: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
}): Promise<TestActionRun> {
  const sql = getTestDb();

  const [inserted] = await sql`
    INSERT INTO runs (
      connection_id, organization_id, run_type,
      status, approval_status,
      action_key, action_input, action_output,
      created_at
    ) VALUES (
      ${options.connection_id},
      ${options.organization_id},
      'action',
      ${options.status ?? 'pending'},
      ${options.approval_status ?? 'pending'},
      ${options.action_key},
      ${sql.json(options.input ?? {})},
      ${sql.json(options.output ?? {})},
      NOW()
    )
    RETURNING id, connection_id, status
  `;

  return {
    id: Number(inserted.id),
    connection_id: Number(inserted.connection_id),
    status: String(inserted.status),
  };
}

// ============================================
// Classifier Fixtures
// ============================================

interface TestClassifier {
  id: number;
  slug: string;
  current_version_id: number;
}

export async function createTestClassifier(options: {
  organization_id: string;
  slug: string;
  name?: string;
  attribute_key?: string;
  attribute_values?: Record<string, any>;
  entity_id?: number;
  status?: string;
}): Promise<TestClassifier> {
  const sql = getTestDb();
  const attributeKey = options.attribute_key ?? options.slug;

  // Ensure seed user for created_by FK
  await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES ('test-seed-user', 'Test Seed User', 'test-seed-user@example.com', 'test-seed-user', true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  const [inserted] = await sql`
    INSERT INTO event_classifiers (
      organization_id, slug, name, attribute_key,
      entity_id, status, created_by,
      created_at, updated_at
    ) VALUES (
      ${options.organization_id},
      ${options.slug},
      ${options.name ?? options.slug},
      ${attributeKey},
      ${options.entity_id ?? null},
      ${options.status ?? 'active'},
      'test-seed-user',
      NOW(), NOW()
    )
    RETURNING id, slug
  `;

  const classifierId = Number(inserted.id);

  const attrValues = options.attribute_values ?? {
    positive: { description: 'Positive' },
    negative: { description: 'Negative' },
    neutral: { description: 'Neutral' },
  };

  const [versionRow] = await sql`
    INSERT INTO event_classifier_versions (
      classifier_id, version, attribute_values, is_current, created_by, created_at
    ) VALUES (
      ${classifierId},
      1,
      ${sql.json(attrValues)},
      true,
      'test-seed-user',
      NOW()
    )
    RETURNING id
  `;

  return {
    id: classifierId,
    slug: options.slug,
    current_version_id: Number(versionRow.id),
  };
}

// ============================================
// Session Fixtures (for requireAuth-protected endpoints)
// ============================================

interface TestSession {
  sessionId: string;
  token: string;
  userId: string;
  cookieHeader: string;
}

export async function createTestSession(userId: string): Promise<TestSession> {
  const sql = getTestDb();
  const sessionId = `session_${generateSecureToken(16)}`;
  const token = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const signedCookie = await serializeSigned('better-auth.session_token', token, TEST_AUTH_SECRET, {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
  });

  await sql`
    INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    VALUES (${sessionId}, ${token}, ${userId}, ${expiresAt}, NOW(), NOW())
  `;

  return {
    sessionId,
    token,
    userId,
    cookieHeader: signedCookie.split(';', 1)[0] || '',
  };
}

// ============================================
// Device Code Fixtures
// ============================================

interface TestDeviceCode {
  deviceCode: string;
  userCode: string;
  clientId: string;
}

export async function createTestDeviceCode(
  clientId: string,
  options?: {
    scope?: string;
    resource?: string;
  }
): Promise<TestDeviceCode> {
  const sql = getTestDb();
  const deviceCode = `dc_${generateSecureToken(16)}`;
  const userCode =
    `${generateSecureToken(2).toUpperCase()}-${generateSecureToken(2).toUpperCase()}`.slice(0, 9);
  const expiresAt = new Date(Date.now() + 600 * 1000); // 10 min

  await sql`
    INSERT INTO oauth_device_codes (
      device_code, user_code, client_id,
      scope, resource, status, poll_interval, expires_at
    ) VALUES (
      ${deviceCode}, ${userCode}, ${clientId},
      ${options?.scope ?? 'mcp:read mcp:write'}, ${options?.resource ?? null},
      'pending', 5, ${expiresAt}
    )
  `;

  return { deviceCode, userCode, clientId };
}

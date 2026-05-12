import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getDb, pgTextArray } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';

const PROVIDER = 'lobu-public-slack';
const DEFAULT_SLACK_PREVIEW_URL = 'https://lobu.ai/slack/developer';
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;
const SURFACES = new Set(['dm', 'channel', 'thread']);

type SurfaceType = 'dm' | 'channel' | 'thread';

interface ClaimRow {
  id: string;
  organization_id: string;
  agent_id: string;
  created_by: string | null;
  allowed_surfaces: string[];
  expires_at: string;
  claimed_at: string | null;
}

function codeHash(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function randomCodeSuffix(): string {
  // 6 base32-ish chars, no ambiguous punctuation.
  return randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
}

function normalizeSurfaces(input: unknown): SurfaceType[] {
  if (!Array.isArray(input) || input.length === 0) return ['dm'];
  const values = input
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value): value is SurfaceType => SURFACES.has(value));
  return Array.from(new Set(values.length > 0 ? values : ['dm']));
}

function normalizeTtlMinutes(input: unknown): number {
  const parsed = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(Math.trunc(parsed), MAX_TTL_MINUTES);
}

function requireOrgUser(c: Context<{ Bindings: Env }>): { organizationId: string; userId: string } | null {
  const organizationId = c.var.organizationId;
  const userId = c.var.session?.userId ?? c.var.user?.id;
  if (!organizationId || !userId) return null;
  return { organizationId, userId };
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireRelayToken(c: Context<{ Bindings: Env }>): Response | null {
  const expected = process.env.LOBU_SLACK_PREVIEW_RELAY_TOKEN || process.env.SLACK_PREVIEW_RELAY_TOKEN;
  if (!expected) {
    return c.json({ error: 'Slack preview relay is not configured' }, 503);
  }
  const provided = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!provided || !safeEquals(provided, expected)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function surfaceKey(params: {
  surfaceType: SurfaceType;
  channelId: string;
  threadTs?: string | null;
}): string {
  if (params.surfaceType === 'thread') {
    return `thread:${params.channelId}:${params.threadTs}`;
  }
  if (params.surfaceType === 'channel') return `channel:${params.channelId}`;
  return `dm:${params.channelId}`;
}

function inferSurfaceType(raw: unknown, threadTs?: string | null): SurfaceType {
  if (typeof raw === 'string' && SURFACES.has(raw)) return raw as SurfaceType;
  return threadTs ? 'thread' : 'dm';
}

function slackPreviewUrl(): string {
  return process.env.LOBU_DEVELOPER_SLACK_URL || DEFAULT_SLACK_PREVIEW_URL;
}

export async function createSlackPreviewClaim(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }

  const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
  if (!agentId) return c.json({ error: 'agent_id is required' }, 400);

  const surfaces = normalizeSurfaces(body.surfaces);
  const ttlMinutes = normalizeTtlMinutes(body.ttl_minutes);
  const codePrefix = slugify(agentId) || 'agent';
  const sql = getDb();

  const agentRows = await sql<{ id: string }>`
    SELECT id
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${auth.organizationId}
    LIMIT 1
  `;
  if (agentRows.length === 0) {
    return c.json(
      {
        error: 'Agent not found',
        message: 'Run `lobu apply` first so Slack Preview can bind to this agent in Lobu Cloud.',
      },
      404
    );
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${codePrefix}-${randomCodeSuffix()}`;
    const hash = codeHash(code);
    try {
      const rows = await sql<{ id: string; expires_at: string }>`
        INSERT INTO agent_preview_claims (
          organization_id, agent_id, created_by, provider, code_hash, code_prefix,
          allowed_surfaces, expires_at
        )
        VALUES (
          ${auth.organizationId}, ${agentId}, ${auth.userId}, ${PROVIDER}, ${hash}, ${codePrefix},
          ${pgTextArray(surfaces)}::text[], now() + (${ttlMinutes} * interval '1 minute')
        )
        RETURNING id, expires_at
      `;
      const expiresAt = rows[0]!.expires_at;
      return c.json({
        id: rows[0]!.id,
        provider: PROVIDER,
        code,
        command: `link ${code}`,
        slack_url: slackPreviewUrl(),
        expires_at: expiresAt,
        allowed_surfaces: surfaces,
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') continue;
      logger.error({ err: errorMessage(err) }, '[SlackPreview] create claim failed');
      return c.json({ error: errorMessage(err) }, 500);
    }
  }

  return c.json({ error: 'Could not allocate a unique preview code' }, 500);
}

export async function bindSlackPreviewClaim(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireRelayToken(c);
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const externalTeamId = typeof body.external_team_id === 'string' ? body.external_team_id.trim() : '';
  const externalChannelId =
    typeof body.external_channel_id === 'string' ? body.external_channel_id.trim() : '';
  const externalUserId = typeof body.external_user_id === 'string' ? body.external_user_id.trim() : null;
  const externalThreadTs =
    typeof body.external_thread_ts === 'string' && body.external_thread_ts.trim()
      ? body.external_thread_ts.trim()
      : null;
  const surfaceType = inferSurfaceType(body.surface_type, externalThreadTs);

  if (!code || !externalTeamId || !externalChannelId) {
    return c.json({ error: 'code, external_team_id, and external_channel_id are required' }, 400);
  }
  if (surfaceType === 'thread' && !externalThreadTs) {
    return c.json({ error: 'external_thread_ts is required for thread bindings' }, 400);
  }

  const key = surfaceKey({ surfaceType, channelId: externalChannelId, threadTs: externalThreadTs });
  const sql = getDb();

  try {
    const result = await sql.begin(async (tx) => {
      const claims = await tx<ClaimRow>`
        SELECT id, organization_id, agent_id, created_by, allowed_surfaces, expires_at, claimed_at
        FROM agent_preview_claims
        WHERE provider = ${PROVIDER}
          AND code_hash = ${codeHash(code)}
        FOR UPDATE
      `;
      const claim = claims[0];
      if (!claim) return { status: 'not_found' as const };
      if (claim.claimed_at) return { status: 'already_claimed' as const };
      if (new Date(claim.expires_at).getTime() <= Date.now()) return { status: 'expired' as const };
      if (!claim.allowed_surfaces.includes(surfaceType)) return { status: 'surface_not_allowed' as const };

      const inserted = await tx<{ id: string }>`
        INSERT INTO agent_preview_bindings (
          organization_id, agent_id, created_by, claim_id, provider, surface_type,
          external_team_id, external_user_id, external_channel_id, external_thread_ts,
          surface_key, metadata
        )
        VALUES (
          ${claim.organization_id}, ${claim.agent_id}, ${claim.created_by}, ${claim.id}, ${PROVIDER}, ${surfaceType},
          ${externalTeamId}, ${externalUserId}, ${externalChannelId}, ${externalThreadTs},
          ${key}, ${tx.json({ source: 'slack-preview-relay' })}
        )
        RETURNING id
      `;

      await tx`
        UPDATE agent_preview_claims
        SET claimed_at = now(),
            claimed_by_external = ${tx.json({
              team_id: externalTeamId,
              user_id: externalUserId,
              channel_id: externalChannelId,
              thread_ts: externalThreadTs,
              surface_type: surfaceType,
              surface_key: key,
            })}
        WHERE id = ${claim.id}
      `;

      return {
        status: 'bound' as const,
        bindingId: inserted[0]!.id,
        organizationId: claim.organization_id,
        agentId: claim.agent_id,
        surfaceKey: key,
      };
    });

    if (result.status === 'not_found') return c.json({ error: 'Preview code not found' }, 404);
    if (result.status === 'expired') return c.json({ error: 'Preview code expired' }, 410);
    if (result.status === 'already_claimed') return c.json({ error: 'Preview code already used' }, 409);
    if (result.status === 'surface_not_allowed') {
      return c.json({ error: `Preview code is not valid for ${surfaceType} bindings` }, 400);
    }

    return c.json({
      status: 'bound',
      binding_id: result.bindingId,
      organization_id: result.organizationId,
      agent_id: result.agentId,
      surface_key: result.surfaceKey,
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      return c.json(
        {
          error: 'Slack surface is already linked',
          message: 'Run `unlink` in Slack before linking this DM, channel, or thread to another agent.',
        },
        409
      );
    }
    logger.error({ err: errorMessage(err) }, '[SlackPreview] bind claim failed');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

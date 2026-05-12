import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';

// Slack Preview lets people trying Lobu locally talk to their agent through the
// hosted "Lobu Developer" Slack workspace before they have their own bot token.
// It rides on two existing tables — no Slack-Preview-specific schema:
//   * `oauth_states` (scope `slack-preview-claim`) holds the short-lived link code.
//   * `agent_channel_bindings` (platform `slack-preview`) holds the live
//     surface → agent mapping the relay routes on.

const PROVIDER = 'lobu-public-slack';
const BINDING_PLATFORM = 'slack-preview';
const CLAIM_SCOPE = 'slack-preview-claim';
const DEFAULT_SLACK_PREVIEW_URL = 'https://lobu.ai/slack/developer';
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;
const SURFACES = new Set(['dm', 'channel', 'thread']);

type SurfaceType = 'dm' | 'channel' | 'thread';

interface ClaimPayload {
  organizationId: string;
  agentId: string;
  createdBy: string | null;
  allowedSurfaces: SurfaceType[];
  createdAt: number;
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

  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${codePrefix}-${randomCodeSuffix()}`;
    const payload: ClaimPayload = {
      organizationId: auth.organizationId,
      agentId,
      createdBy: auth.userId,
      allowedSurfaces: surfaces,
      createdAt: Date.now(),
    };
    try {
      await sql`
        INSERT INTO oauth_states (id, scope, payload, expires_at)
        VALUES (${codeHash(code)}, ${CLAIM_SCOPE}, ${sql.json(payload)}, ${expiresAt})
      `;
      return c.json({
        provider: PROVIDER,
        code,
        command: `link ${code}`,
        slack_url: slackPreviewUrl(),
        expires_at: expiresAt.toISOString(),
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
      const claims = await tx<{ payload: ClaimPayload }>`
        DELETE FROM oauth_states
        WHERE id = ${codeHash(code)}
          AND scope = ${CLAIM_SCOPE}
          AND expires_at > now()
        RETURNING payload
      `;
      const claim = claims[0]?.payload;
      if (!claim) return { status: 'not_found' as const };
      if (!claim.allowedSurfaces.includes(surfaceType)) return { status: 'surface_not_allowed' as const };

      const inserted = await tx`
        INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
        VALUES (${claim.agentId}, ${BINDING_PLATFORM}, ${key}, ${externalTeamId}, now())
        ON CONFLICT (platform, channel_id, team_id) DO NOTHING
        RETURNING agent_id
      `;
      if (inserted.length === 0) return { status: 'already_linked' as const };

      return {
        status: 'bound' as const,
        organizationId: claim.organizationId,
        agentId: claim.agentId,
        surfaceKey: key,
      };
    });

    if (result.status === 'not_found') {
      return c.json({ error: 'Preview code not found or expired' }, 404);
    }
    if (result.status === 'surface_not_allowed') {
      return c.json({ error: `Preview code is not valid for ${surfaceType} bindings` }, 400);
    }
    if (result.status === 'already_linked') {
      return c.json(
        {
          error: 'Slack surface is already linked',
          message: 'Run `unlink` in Slack before linking this DM, channel, or thread to another agent.',
        },
        409
      );
    }

    return c.json({
      status: 'bound',
      organization_id: result.organizationId,
      agent_id: result.agentId,
      surface_key: result.surfaceKey,
    });
  } catch (err: unknown) {
    logger.error({ err: errorMessage(err) }, '[SlackPreview] bind claim failed');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

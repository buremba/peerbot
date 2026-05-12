import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';

// Slack Preview lets people trying Lobu locally talk to their agent through the
// hosted "Lobu Developer" Slack workspace before they have their own bot token.
// There is no Slack-Preview-specific schema or transport:
//   * The link code lives in `oauth_states` (scope `slack-preview-claim`).
//   * The hosted "Lobu Developer" workspace is just an ordinary Slack
//     `agent_connections` row (no env var, no relay service).
//   * `/lobu link <code>` in that workspace consumes the claim and writes a normal
//     `agent_channel_bindings` row (platform `slack`) — so inbound messages
//     route through the exact same Chat SDK adapter path every other platform
//     connection uses.

const PROVIDER = 'lobu-public-slack';
// Preview bindings are plain Slack bindings; the workspace's team_id keeps them
// from colliding with anyone's own bot. Slack DM channel ids start with `D`.
const SLACK_PLATFORM = 'slack';
const CLAIM_SCOPE = 'slack-preview-claim';
const DEFAULT_SLACK_PREVIEW_URL = 'https://lobu.ai/slack/developer';
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;
const SURFACES = new Set(['dm', 'channel']);

export type SurfaceType = 'dm' | 'channel';

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

function slackPreviewUrl(): string {
  return process.env.LOBU_DEVELOPER_SLACK_URL || DEFAULT_SLACK_PREVIEW_URL;
}

/**
 * Slack convention: DM channels start with `D`; everything else is a
 * group/channel. The bridge sometimes hands us the Chat SDK thread id
 * (`slack:D012…` / `slack:C012…:172…`) rather than the bare channel id, so
 * strip a leading transport prefix and any thread-ts suffix before the check.
 */
export function slackSurfaceType(channelId: string): SurfaceType {
  const id = channelId.replace(/^[a-z]+:/i, '').split(':')[0]!;
  return id.startsWith('D') ? 'dm' : 'channel';
}

/**
 * POST /api/:orgSlug/preview/slack/claims — called by `lobu run` (authenticated
 * via mcpAuth) to mint a short-lived `/lobu link` code for one of the org's agents.
 */
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
        command: `/lobu link ${code}`,
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

export type ConsumeClaimResult =
  | { status: 'bound'; agentId: string; organizationId: string }
  | { status: 'not_found' }
  | { status: 'surface_not_allowed'; surfaceType: SurfaceType };

/**
 * Consume a `/lobu link` code and bind the originating Slack channel/DM to the
 * agent the code was minted for. One-time use; last link for a surface wins
 * (re-linking just rebinds — there's no separate unlink step). Called from the
 * `link` chat command, so it never touches HTTP.
 */
export async function consumeSlackPreviewClaim(args: {
  code: string;
  teamId: string;
  channelId: string;
}): Promise<ConsumeClaimResult> {
  const { code, teamId, channelId } = args;
  const surfaceType = slackSurfaceType(channelId);
  const sql = getDb();

  return sql.begin(async (tx) => {
    const claims = await tx<{ payload: ClaimPayload }>`
      DELETE FROM oauth_states
      WHERE id = ${codeHash(code)}
        AND scope = ${CLAIM_SCOPE}
        AND expires_at > now()
      RETURNING payload
    `;
    const claim = claims[0]?.payload;
    if (!claim) return { status: 'not_found' as const };
    if (!claim.allowedSurfaces.includes(surfaceType)) {
      return { status: 'surface_not_allowed' as const, surfaceType };
    }

    // Mirrors ChannelBindingService.createBinding's upsert for the team-set
    // case — last link wins.
    await tx`
      INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
      VALUES (${claim.agentId}, ${SLACK_PLATFORM}, ${channelId}, ${teamId}, now())
      ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET agent_id = EXCLUDED.agent_id
    `;

    return {
      status: 'bound' as const,
      agentId: claim.agentId,
      organizationId: claim.organizationId,
    };
  });
}

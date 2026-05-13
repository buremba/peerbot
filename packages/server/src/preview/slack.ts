import { createHash, randomInt } from 'node:crypto';
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

// Slack DM channel ids start with `D`; the canonical binding key is `slack:<id>`.
const SLACK_PLATFORM = 'slack';
const CLAIM_SCOPE = 'slack-preview-claim';
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;
const SURFACES = new Set(['dm', 'channel']);

// Hosted preview bots — the platforms a `preview.<platform>` block / claim mint
// is allowed for, and the default "join the workspace" links.
const PREVIEW_PLATFORMS = new Set(['slack', 'telegram']);
const PREVIEW_JOIN_DEFAULTS: Record<string, string> = {
  slack: 'https://lobu.ai/slack',
  telegram: 'https://t.me/lobuaibot',
};

export type SurfaceType = 'dm' | 'channel';

// Slash-command spellings differ by platform: Slack only delivers the
// natively-registered `/lobu`, so its subcommands are `/lobu try` etc.; other
// platforms register each command directly (`/try`, `/agents`, `/link`).
function tryCommand(platform: string): string {
  return platform === 'slack' ? '/lobu try' : '/try';
}
function listCommand(platform: string): string {
  return platform === 'slack' ? '/lobu agents' : '/agents';
}
function linkCommand(platform: string): string {
  return platform === 'slack' ? '/lobu link' : '/link';
}

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

// Uppercase letters + digits — readable, no ambiguous punctuation, and a fixed
// length (the old base64url-then-strip approach could yield < 6 chars when the
// random bytes happened to land on `-`/`_`).
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomCodeSuffix(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
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

// "Join the hosted workspace" link for a preview platform — overridable per
// platform via `LOBU_PREVIEW_<PLATFORM>_URL` on the deployment.
function previewJoinUrl(platform: string): string {
  return (
    process.env[`LOBU_PREVIEW_${platform.toUpperCase()}_URL`] ||
    PREVIEW_JOIN_DEFAULTS[platform] ||
    ''
  );
}

/** The slash command to send to the hosted bot to redeem a code. */
function previewLinkCommand(platform: string, code: string): string {
  return platform === 'slack' ? `/lobu link ${code}` : `/link ${code}`;
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
 * `agent_channel_bindings.channel_id` stores Slack channels in the canonical
 * `slack:<id>` form that the message-handler bridge looks up via `getBinding`
 * (`thread.channelId`). The `/lobu link` slash command hands us the bare Slack
 * channel id (`D…` / `C…`), so prefix it; a value that already carries a
 * transport prefix is left as-is.
 */
export function canonicalSlackChannelId(channelId: string): string {
  return /^[a-z]+:/i.test(channelId)
    ? channelId
    : `${SLACK_PLATFORM}:${channelId}`;
}

/**
 * POST /api/:orgSlug/preview/claims — called by `lobu run` (mcpAuth) to mint a
 * short-lived link code for one of the org's agents on a hosted preview platform.
 * Body: `{ agent_id, platform, surfaces?, ttl_minutes? }`.
 */
export async function createPreviewClaim(c: Context<{ Bindings: Env }>) {
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

  const platform =
    typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
  if (!PREVIEW_PLATFORMS.has(platform)) {
    return c.json(
      {
        error: 'Unsupported preview platform',
        message: `platform must be one of: ${[...PREVIEW_PLATFORMS].join(', ')}`,
      },
      400
    );
  }

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
        message: 'Run `lobu apply` first so the preview bot can bind to this agent in Lobu Cloud.',
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
        provider: `lobu-public-${platform}`,
        platform,
        code,
        command: previewLinkCommand(platform, code),
        join_url: previewJoinUrl(platform),
        expires_at: expiresAt.toISOString(),
        allowed_surfaces: surfaces,
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') continue;
      logger.error({ err: errorMessage(err), platform }, '[preview] create claim failed');
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
 * Consume a `/lobu link` (a.k.a. `/link`) code and bind the originating chat to
 * the agent the code was minted for. One-time use; last link for a surface wins
 * (re-linking just rebinds — there's no separate unlink step). Called from the
 * `link` chat command, so it never touches HTTP.
 *
 * Platform-agnostic: the caller supplies the `platform`, the canonical
 * `channelId` form that platform's message handler looks bindings up by (for
 * Slack: `canonicalSlackChannelId`), the workspace/`teamId` if the platform has
 * one, and the resolved `surfaceType` (dm vs channel).
 */
export async function consumePreviewClaim(args: {
  code: string;
  platform: string;
  /** Workspace id for platforms that have one (Slack); undefined otherwise. */
  teamId?: string;
  channelId: string;
  surfaceType: SurfaceType;
}): Promise<ConsumeClaimResult> {
  const { code, platform, teamId, channelId, surfaceType } = args;
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

    // Upsert the binding — last link for this chat wins. `ON CONFLICT` can't
    // target a NULL `team_id`, so for platforms without a workspace concept
    // (team_id null) we delete-then-insert inside the tx instead.
    if (teamId) {
      await tx`
        INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
        VALUES (${claim.agentId}, ${platform}, ${channelId}, ${teamId}, now())
        ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET agent_id = EXCLUDED.agent_id
      `;
    } else {
      await tx`
        DELETE FROM agent_channel_bindings
        WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
      `;
      await tx`
        INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
        VALUES (${claim.agentId}, ${platform}, ${channelId}, NULL, now())
      `;
    }

    return {
      status: 'bound' as const,
      agentId: claim.agentId,
      organizationId: claim.organizationId,
    };
  });
}

// ── Public-preview "try a demo agent" ────────────────────────────────────────
//
// A `previewMode` connection (the hosted "Lobu" workspace bot) exposes every
// agent in *its own org* as a self-serve demo: `/lobu try <agentId>` binds the
// chat to that agent — no claim code, no ownership check, no CLI. "The org" is
// whatever org owns the preview connection's agent; drop your demo agents in it
// (via `lobu apply` / the agents UI) and they show up here automatically. The
// connection's own placeholder/concierge agent is excluded from the list.

export interface PreviewAgent {
  agentId: string;
  name: string;
  description: string | null;
}

/**
 * Resolve the org a preview connection's demo agents live in (the org of its
 * owning agent), plus that owning agent's id (excluded from the demo list).
 * Returns null when the connection or its owning agent can't be resolved.
 */
async function resolvePreviewConnectionOrg(
  connectionId: string
): Promise<{ organizationId: string; owningAgentId: string } | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT a.organization_id, c.agent_id
    FROM agent_connections c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ${connectionId}
    LIMIT 1
  `) as Array<{ organization_id: string | null; agent_id: string | null }>;
  const row = rows[0];
  if (!row?.organization_id || !row.agent_id) return null;
  return { organizationId: row.organization_id, owningAgentId: row.agent_id };
}

/**
 * Demo agents reachable via `/lobu try` through this preview connection. Best
 * effort: returns `[]` (and logs) on any DB error rather than throwing — this
 * runs on the hot path of every unlinked message and the worst case is a
 * fallback notice instead of the menu.
 */
export async function listPreviewAgents(connectionId: string): Promise<PreviewAgent[]> {
  try {
    const org = await resolvePreviewConnectionOrg(connectionId);
    if (!org) return [];
    const sql = getDb();
    const rows = (await sql`
      SELECT id, name, description
      FROM agents
      WHERE organization_id = ${org.organizationId}
        AND id <> ${org.owningAgentId}
      ORDER BY name NULLS LAST, id
    `) as Array<{ id: string; name: string | null; description: string | null }>;
    return rows.map((r) => ({
      agentId: r.id,
      name: r.name ?? r.id,
      description: r.description ?? null,
    }));
  } catch (err) {
    logger.warn(
      { err: errorMessage(err), connectionId },
      '[preview] listPreviewAgents failed'
    );
    return [];
  }
}

export type BindPreviewAgentResult =
  | { status: 'bound'; agentId: string }
  | { status: 'not_available' }
  | { status: 'no_connection' };

/**
 * Bind a chat to a demo agent for a preview connection. The agent must live in
 * the connection's org — that's the allowlist; there's no per-caller ownership
 * check (that's the whole point: anyone in the hosted workspace can try them).
 * Last bind wins; re-running with another agent just rebinds.
 */
export async function bindChatToPreviewAgent(args: {
  connectionId: string;
  agentId: string;
  platform: string;
  /** Workspace id for platforms that have one (Slack); undefined otherwise. */
  teamId?: string;
  /** Canonical channel id the message handler looks bindings up by. */
  channelId: string;
}): Promise<BindPreviewAgentResult> {
  const org = await resolvePreviewConnectionOrg(args.connectionId);
  if (!org) return { status: 'no_connection' };
  const sql = getDb();
  const agentRows = (await sql`
    SELECT id FROM agents
    WHERE id = ${args.agentId} AND organization_id = ${org.organizationId}
    LIMIT 1
  `) as Array<{ id: string }>;
  const target = agentRows[0];
  if (!target) return { status: 'not_available' };

  const { platform, teamId, channelId } = args;
  if (teamId) {
    await sql`
      INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
      VALUES (${target.id}, ${platform}, ${channelId}, ${teamId}, now())
      ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET agent_id = EXCLUDED.agent_id
    `;
  } else {
    await sql`
      DELETE FROM agent_channel_bindings
      WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
    `;
    await sql`
      INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
      VALUES (${target.id}, ${platform}, ${channelId}, NULL, now())
    `;
  }
  return { status: 'bound', agentId: target.id };
}

/** The "pick a demo agent" menu — shown on `/lobu try` / `/lobu agents`. */
export function previewAgentMenu(platform: string, agents: PreviewAgent[]): string {
  if (agents.length === 0) {
    return 'No demo agents are available here yet.';
  }
  return [
    'Demo agents you can try here:',
    ...agents.map(
      (a) => `• \`${tryCommand(platform)} ${a.agentId}\` — ${a.description || a.name}`
    ),
    '',
    `Pick one, then just send a message. \`${listCommand(platform)}\` shows this list again.`,
  ].join('\n');
}

/**
 * Reply for a `previewMode` connection when an unlinked chat arrives. If the
 * connection's org has demo agents, it's the `/lobu try` menu; otherwise it
 * falls back to "wire your own agent" instructions. Returns null only when
 * there's nothing useful to say (unknown platform).
 */
export async function previewUnlinkedNotice(
  platform: string,
  connectionId: string
): Promise<string | null> {
  if (!PREVIEW_PLATFORMS.has(platform)) return null;
  const agents = await listPreviewAgents(connectionId);
  if (agents.length > 0) {
    return [
      `👋 Welcome! ${previewAgentMenu(platform, agents)}`,
      '',
      `(Building your own agent? Run \`lobu run\` and send the \`${linkCommand(platform)} <code>\` it prints.)`,
    ].join('\n');
  }
  return [
    "👋 This chat isn't linked to a Lobu agent yet.",
    '',
    `Run \`lobu apply\` then \`lobu run\` to get a \`${linkCommand(platform)} <code>\`, and send it here.`,
  ].join('\n');
}

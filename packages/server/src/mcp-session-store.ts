import { getDb } from './db/client';

export interface PersistedMcpSession {
  sessionId: string;
  userId: string | null;
  clientId: string | null;
  organizationId: string | null;
  memberRole: string | null;
  requestedAgentId: string | null;
  isAuthenticated: boolean;
  scopedToOrg: boolean;
  lastAccessedAt: number;
  expiresAt: number;
}

function fromDate(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fromBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
  }
  return false;
}

export class McpSessionStore {
  async upsertSession(session: PersistedMcpSession): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO mcp_sessions (
        session_id,
        user_id,
        client_id,
        organization_id,
        member_role,
        requested_agent_id,
        is_authenticated,
        scoped_to_org,
        last_accessed_at,
        expires_at
      ) VALUES (
        ${session.sessionId},
        ${session.userId},
        ${session.clientId},
        ${session.organizationId},
        ${session.memberRole},
        ${session.requestedAgentId},
        ${session.isAuthenticated},
        ${session.scopedToOrg},
        ${new Date(session.lastAccessedAt)},
        ${new Date(session.expiresAt)}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        client_id = EXCLUDED.client_id,
        organization_id = EXCLUDED.organization_id,
        member_role = EXCLUDED.member_role,
        requested_agent_id = EXCLUDED.requested_agent_id,
        is_authenticated = EXCLUDED.is_authenticated,
        scoped_to_org = EXCLUDED.scoped_to_org,
        last_accessed_at = EXCLUDED.last_accessed_at,
        expires_at = EXCLUDED.expires_at
    `;
  }

  async getSession(sessionId: string): Promise<PersistedMcpSession | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT *
      FROM mcp_sessions
      WHERE session_id = ${sessionId}
        AND expires_at > NOW()
      LIMIT 1
    `;
    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    return {
      sessionId: String(row.session_id),
      userId: typeof row.user_id === 'string' ? row.user_id : null,
      clientId: typeof row.client_id === 'string' ? row.client_id : null,
      organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
      memberRole: typeof row.member_role === 'string' ? row.member_role : null,
      requestedAgentId: typeof row.requested_agent_id === 'string' ? row.requested_agent_id : null,
      isAuthenticated: fromBool(row.is_authenticated),
      scopedToOrg: fromBool(row.scoped_to_org),
      lastAccessedAt: fromDate(row.last_accessed_at) ?? Date.now(),
      expiresAt: fromDate(row.expires_at) ?? Date.now(),
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM mcp_sessions WHERE session_id = ${sessionId}`;
  }

  async deleteExpiredSessions(): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM mcp_sessions WHERE expires_at <= NOW()`;
  }
}

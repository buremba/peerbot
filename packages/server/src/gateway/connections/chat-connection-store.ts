/**
 * ChatConnectionStore — durable storage for chat-platform connection rows
 * (Telegram, Slack, Discord, WhatsApp, Teams, Google Chat). Backed by
 * `public.chat_connections`, which is distinct from `public.connections`
 * (the Owletto product connector table).
 */

import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type {
  ConnectionSettings,
  PlatformAdapterConfig,
  PlatformConnection,
} from "./types.js";

const logger = createLogger("chat-connection-store");

interface ChatConnectionRow {
  id: string;
  platform: string;
  template_agent_id: string | null;
  config: PlatformAdapterConfig;
  settings: ConnectionSettings;
  metadata: Record<string, unknown>;
  status: string;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToConnection(row: ChatConnectionRow): PlatformConnection {
  const out: PlatformConnection = {
    id: row.id,
    platform: row.platform,
    config: row.config,
    settings: row.settings,
    metadata: row.metadata as PlatformConnection["metadata"],
    status: row.status as PlatformConnection["status"],
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
  if (row.template_agent_id) {
    out.templateAgentId = row.template_agent_id;
  }
  if (row.error_message) {
    out.errorMessage = row.error_message;
  }
  return out;
}

export class ChatConnectionStore {
  async get(id: string): Promise<PlatformConnection | null> {
    const sql = getDb();
    const rows = await sql<ChatConnectionRow>`
      SELECT id, platform, template_agent_id, config, settings, metadata,
             status, error_message, created_at, updated_at
      FROM chat_connections
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? rowToConnection(rows[0]) : null;
  }

  async listAll(): Promise<PlatformConnection[]> {
    const sql = getDb();
    const rows = await sql<ChatConnectionRow>`
      SELECT id, platform, template_agent_id, config, settings, metadata,
             status, error_message, created_at, updated_at
      FROM chat_connections
      ORDER BY created_at ASC
    `;
    return rows.map(rowToConnection);
  }

  async listByAgent(templateAgentId: string): Promise<PlatformConnection[]> {
    const sql = getDb();
    const rows = await sql<ChatConnectionRow>`
      SELECT id, platform, template_agent_id, config, settings, metadata,
             status, error_message, created_at, updated_at
      FROM chat_connections
      WHERE template_agent_id = ${templateAgentId}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToConnection);
  }

  /**
   * Insert-or-update by id. The full row is rewritten — partial updates from
   * the higher-level ChatInstanceManager always merge before calling this.
   */
  async upsert(connection: PlatformConnection): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO chat_connections (
        id, platform, template_agent_id, config, settings, metadata,
        status, error_message, created_at, updated_at
      )
      VALUES (
        ${connection.id},
        ${connection.platform},
        ${connection.templateAgentId ?? null},
        ${sql.json(connection.config as Record<string, unknown>)},
        ${sql.json(connection.settings ?? {})},
        ${sql.json(connection.metadata ?? {})},
        ${connection.status},
        ${connection.errorMessage ?? null},
        ${new Date(connection.createdAt)},
        ${new Date(connection.updatedAt)}
      )
      ON CONFLICT (id) DO UPDATE SET
        platform = EXCLUDED.platform,
        template_agent_id = EXCLUDED.template_agent_id,
        config = EXCLUDED.config,
        settings = EXCLUDED.settings,
        metadata = EXCLUDED.metadata,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        updated_at = EXCLUDED.updated_at
    `;
    logger.debug({ id: connection.id }, "Upserted chat_connection");
  }

  async delete(id: string): Promise<void> {
    const sql = getDb();
    await sql`DELETE FROM chat_connections WHERE id = ${id}`;
    logger.debug({ id }, "Deleted chat_connection");
  }
}

import { createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";

const logger = createLogger("model-preference-store");

/**
 * Per-user model preference, keyed by `(userId, providerId)`.
 *
 * Backed by `public.user_model_preferences`. Used by the Claude OAuth module
 * (and similar) to remember which model a user picked the last time they
 * authed against a given provider.
 */
export class ModelPreferenceStore {
  constructor(private readonly providerId: string) {}

  async setModelPreference(userId: string, model: string): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO user_model_preferences (user_id, provider_id, model, updated_at)
      VALUES (${userId}, ${this.providerId}, ${model}, now())
      ON CONFLICT (user_id, provider_id) DO UPDATE SET
        model = EXCLUDED.model,
        updated_at = now()
    `;
    logger.info(
      `Set ${this.providerId} model preference for user ${userId}: ${model}`
    );
  }

  async getModelPreference(userId: string): Promise<string | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT model FROM user_model_preferences
      WHERE user_id = ${userId} AND provider_id = ${this.providerId}
    `;
    if (rows.length === 0) return null;
    return rows[0].model as string;
  }

  async deleteModelPreference(userId: string): Promise<void> {
    const sql = getDb();
    await sql`
      DELETE FROM user_model_preferences
      WHERE user_id = ${userId} AND provider_id = ${this.providerId}
    `;
    logger.info(`Deleted ${this.providerId} model preference for user ${userId}`);
  }
}

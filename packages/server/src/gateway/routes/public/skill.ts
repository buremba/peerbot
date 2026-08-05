/**
 * Public onboarding skill routes.
 *
 * Serves the same `skill://lobu` markdown that the MCP resource exposes
 * (see mcp-handler.ts), over plain HTTP so the web app or a connected
 * agent's CLI can fetch it without an MCP session. The content is a
 * committed generated constant (scripts/gen-skill-resource.ts), so it
 * ships identically in prod and local dev.
 */
import { Hono } from "hono";
import { LOBU_SKILL_MARKDOWN } from "../../../skills/lobu-skill.generated";

export function createSkillRoutes() {
  const app = new Hono();

  app.get("/skill/lobu", (c) => c.json({ markdown: LOBU_SKILL_MARKDOWN }));

  return app;
}

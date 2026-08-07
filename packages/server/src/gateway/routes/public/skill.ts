/**
 * Public onboarding skill routes.
 *
 * Serves the same `skill://lobu` markdown that the MCP resource exposes
 * (see mcp-handler.ts), over plain HTTP so the web app or a connected
 * agent's CLI can fetch it without an MCP session. The content is a
 * committed generated constant (scripts/gen-skill-resource.ts), so it
 * ships identically in prod and local dev.
 *
 * Raw markdown (text/markdown), not JSON: the landing copy-prompt tells an
 * agent to "fetch the Lobu skill" at this URL, and a bash-only agent doing
 * `curl` should get the skill directly rather than having to unwrap a
 * `{ markdown }` envelope.
 */
import { Hono } from "hono";
import { LOBU_SKILL_MARKDOWN } from "../../../skills/lobu-skill.generated";

export function createSkillRoutes() {
  const app = new Hono();

  app.get("/skill/lobu", (c) =>
    c.text(LOBU_SKILL_MARKDOWN, 200, { "Content-Type": "text/markdown; charset=utf-8" })
  );

  return app;
}

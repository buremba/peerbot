import { describe, expect, it } from "bun:test";
import { createSkillRoutes } from "../../../gateway/routes/public/skill";
import { LOBU_SKILL_MARKDOWN } from "../../../skills/lobu-skill.generated";

// Drift between LOBU_SKILL_MARKDOWN and the authored skills/lobu/SKILL.md is
// guarded by skills/__tests__/lobu-skill-resource.test.ts; this suite only
// covers the HTTP surface.
describe("public skill route", () => {
  const app = createSkillRoutes();

  it("serves the embedded Lobu skill markdown over HTTP", async () => {
    const res = await app.request("/skill/lobu");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toBe(LOBU_SKILL_MARKDOWN);
  });
});

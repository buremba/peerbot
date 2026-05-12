import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { lobuConfigSchema } from "../lobu-toml-schema";

const BASE_AGENT = `
[agents.triage]
name = "Triage"
dir = "./agents/triage"
`;

describe("lobu.toml memory schema", () => {
  test("accepts flattened [memory] fields", () => {
    const parsed = parseToml(`${BASE_AGENT}
[memory]
enabled = true
org = "dev"
name = "Local Dev"
models = "./models"
data = "./data"
`);

    const result = lobuConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory?.org).toBe("dev");
      expect(result.data.memory?.models).toBe("./models");
    }
  });

  for (const legacyKey of ["lobu", "owletto"]) {
    test(`rejects stale nested [memory.${legacyKey}] fields`, () => {
      const parsed = parseToml(`${BASE_AGENT}
[memory.${legacyKey}]
enabled = false
org = "dev"
models = "./custom-models"
`);

      const result = lobuConfigSchema.safeParse(parsed);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["memory"],
              message: expect.stringContaining(legacyKey),
            }),
          ])
        );
      }
    });
  }

  test("rejects the removed inline [memory.schema] block", () => {
    const parsed = parseToml(`${BASE_AGENT}
[memory]
enabled = true
org = "dev"
name = "Local Dev"

[[memory.schema.entity_types]]
slug = "person"
`);

    const result = lobuConfigSchema.safeParse(parsed);

    expect(result.success).toBe(false);
  });
});

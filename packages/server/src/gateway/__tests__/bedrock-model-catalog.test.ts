import { describe, expect, test } from "bun:test";
import { BedrockModelCatalog } from "../services/bedrock-model-catalog.js";

describe("BedrockModelCatalog", () => {
  test("returns configured models from the loader", async () => {
    const catalog = new BedrockModelCatalog({
      cacheTtlMs: 0,
      loadModels: async () => [
        {
          id: "amazon.nova-lite-v1:0",
          label: "Amazon / Nova Lite",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
      ],
    });

    await expect(catalog.listModelOptions()).resolves.toEqual([
      {
        id: "amazon.nova-lite-v1:0",
        label: "Amazon / Nova Lite",
      },
    ]);
  });

  test("falls back to the static registry when AWS loading fails", async () => {
    const catalog = new BedrockModelCatalog({
      cacheTtlMs: 0,
      loadModels: async () => {
        throw new Error("boom");
      },
    });

    const models = await catalog.listModelOptions();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.id === "amazon.nova-lite-v1:0")).toBe(
      true
    );
  });
});

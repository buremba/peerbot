import { describe, expect, test } from "bun:test";
import { ProviderCatalogService } from "../provider-catalog.js";

/**
 * findProviderForModel routes a stored model string to the provider module that
 * owns it. The subtle case (regressed once, now guarded): Lobu stores models
 * PREFIXED with the provider's lobu id ("claude/claude-sonnet-4-6"), but
 * Claude's `getModelOptions` lists BARE ids ("claude-sonnet-4-6", fetched live
 * and sometimes empty in this resolution context). With exact-match only, a
 * "claude/…" model matched nothing and fell through to the first credentialed
 * provider — mis-routing the request to e.g. gemini's openai-compat endpoint and
 * surfacing as a confusing 404. The "<providerId>/…" prefix fallback fixes that.
 *
 * findProviderForModel reads only its arguments (never `this`), so we exercise
 * the real method with injected fake provider modules — no store/auth/registry
 * wiring required.
 */
describe("ProviderCatalogService.findProviderForModel — prefix routing", () => {
  const catalog = new ProviderCatalogService(
    {} as never,
    {} as never,
    {} as never
  );

  // Mirrors the bug's provider set: gemini is credentialed FIRST, claude lists
  // BARE ids (no "claude/" prefix), and the stored model is PREFIXED.
  const fakeProviders = [
    {
      providerId: "gemini",
      getModelOptions: async () => [{ value: "gemini-2.5-flash" }],
    },
    {
      providerId: "claude",
      getModelOptions: async () => [
        { value: "claude-sonnet-4-6" },
        { value: "claude-opus-4-8" },
      ],
    },
  ] as never;

  test("routes a prefixed claude/ model to the claude provider (not the first credentialed)", async () => {
    const picked = await catalog.findProviderForModel(
      "claude/claude-sonnet-4-6",
      fakeProviders
    );
    expect(picked?.providerId).toBe("claude");
  });

  test("opus-4-8 (bare id absent from a sparse live list) still routes by prefix", async () => {
    const sparse = [
      {
        providerId: "gemini",
        getModelOptions: async () => [{ value: "gemini-2.5-flash" }],
      },
      // Live Claude list came back empty in this context — only the prefix can
      // identify the provider now.
      { providerId: "claude", getModelOptions: async () => [] },
    ] as never;
    const picked = await catalog.findProviderForModel(
      "claude/claude-opus-4-8",
      sparse
    );
    expect(picked?.providerId).toBe("claude");
  });

  test("an exact bare-id match still wins (non-prefixed model)", async () => {
    const picked = await catalog.findProviderForModel(
      "gemini-2.5-flash",
      fakeProviders
    );
    expect(picked?.providerId).toBe("gemini");
  });

  test("exact match is preferred over the prefix fallback", async () => {
    // A provider literally lists "claude/legacy" as a value; the bare-loop must
    // match it before the prefix fallback ever runs.
    const providers = [
      {
        providerId: "openrouter",
        getModelOptions: async () => [{ value: "claude/legacy" }],
      },
      {
        providerId: "claude",
        getModelOptions: async () => [{ value: "claude-sonnet-4-6" }],
      },
    ] as never;
    const picked = await catalog.findProviderForModel(
      "claude/legacy",
      providers
    );
    expect(picked?.providerId).toBe("openrouter");
  });

  test("returns undefined when neither an exact value nor a prefix provider matches", async () => {
    const picked = await catalog.findProviderForModel(
      "mystery/model-x",
      fakeProviders
    );
    expect(picked).toBeUndefined();
  });

  test("a bare unknown id (no slash) does not match anything", async () => {
    const picked = await catalog.findProviderForModel(
      "totally-unknown",
      fakeProviders
    );
    expect(picked).toBeUndefined();
  });
});

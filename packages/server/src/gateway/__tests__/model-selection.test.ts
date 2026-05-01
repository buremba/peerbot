import { describe, expect, test } from "bun:test";
import {
  getModelSelectionState,
  reconcileModelSelectionForInstalledProviders,
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";

describe("model-selection", () => {
  test("uses legacy model as pinned fallback", () => {
    expect(getModelSelectionState({ model: "openai/gpt-5" })).toEqual({
      mode: "pinned",
      pinnedModel: "openai/gpt-5",
    });
  });

  test("resolves pinned model when pinned provider is installed", () => {
    const effective = resolveEffectiveModelRef({
      modelSelection: { mode: "pinned", pinnedModel: "openai/gpt-5" },
      installedProviders: [
        { providerId: "openai", installedAt: 1 },
        { providerId: "anthropic", installedAt: 2 },
      ],
      providerModelPreferences: {
        openai: "openai/gpt-4.1",
      },
    } as any);

    expect(effective).toBe("openai/gpt-5");
  });

  test("falls back to primary provider preference when pinned provider is removed", () => {
    const effective = resolveEffectiveModelRef({
      modelSelection: { mode: "pinned", pinnedModel: "anthropic/claude-3.7" },
      installedProviders: [{ providerId: "openai", installedAt: 1 }],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-3.7",
      },
    } as any);

    expect(effective).toBe("openai/gpt-5");
  });

  test("reconcile clears invalid pinned selection and removes uninstalled preferences", () => {
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: "anthropic/claude-3.7",
      modelSelection: { mode: "pinned", pinnedModel: "anthropic/claude-3.7" },
      installedProviders: [{ providerId: "openai", installedAt: 1 }],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-3.7",
      },
    } as any);

    expect(reconciled).toEqual({
      modelSelection: { mode: "auto" },
      model: undefined,
      providerModelPreferences: {
        openai: "openai/gpt-5",
      },
    });
  });

  test("reconcile keeps valid pinned selection", () => {
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: "openai/gpt-5",
      modelSelection: { mode: "pinned", pinnedModel: "openai/gpt-5" },
      installedProviders: [{ providerId: "openai", installedAt: 1 }],
      providerModelPreferences: {
        openai: "openai/gpt-4.1",
      },
    } as any);

    expect(reconciled.modelSelection).toEqual({
      mode: "pinned",
      pinnedModel: "openai/gpt-5",
    });
    expect(reconciled.model).toBe("openai/gpt-5");
  });

  test("auto mode follows primary provider order change", () => {
    const before = resolveEffectiveModelRef({
      modelSelection: { mode: "auto" },
      installedProviders: [
        { providerId: "openai", installedAt: 1 },
        { providerId: "anthropic", installedAt: 2 },
      ],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-sonnet-4",
      },
    } as any);
    const after = resolveEffectiveModelRef({
      modelSelection: { mode: "auto" },
      installedProviders: [
        { providerId: "anthropic", installedAt: 2 },
        { providerId: "openai", installedAt: 1 },
      ],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-sonnet-4",
      },
    } as any);

    expect(before).toBe("openai/gpt-5");
    expect(after).toBe("anthropic/claude-sonnet-4");
  });

  test("auto mode can keep non-primary provider preference without affecting effective model", () => {
    const reconciled = reconcileModelSelectionForInstalledProviders({
      modelSelection: { mode: "auto" },
      installedProviders: [
        { providerId: "openai", installedAt: 1 },
        { providerId: "anthropic", installedAt: 2 },
      ],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-opus-4",
      },
    } as any);

    expect(reconciled.providerModelPreferences).toEqual({
      openai: "openai/gpt-5",
      anthropic: "anthropic/claude-opus-4",
    });
    expect(
      resolveEffectiveModelRef({
        modelSelection: reconciled.modelSelection,
        installedProviders: [
          { providerId: "openai", installedAt: 1 },
          { providerId: "anthropic", installedAt: 2 },
        ],
        providerModelPreferences: reconciled.providerModelPreferences,
      } as any)
    ).toBe("openai/gpt-5");
  });

  test("reconcile removes stale preferences when provider is deleted", () => {
    const reconciled = reconcileModelSelectionForInstalledProviders({
      modelSelection: { mode: "auto" },
      installedProviders: [{ providerId: "anthropic", installedAt: 2 }],
      providerModelPreferences: {
        openai: "openai/gpt-5",
        anthropic: "anthropic/claude-sonnet-4",
      },
    } as any);

    expect(reconciled.providerModelPreferences).toEqual({
      anthropic: "anthropic/claude-sonnet-4",
    });
  });

  test("falls back to auto when pinned model has no resolvable provider", () => {
    const reconciled = reconcileModelSelectionForInstalledProviders({
      modelSelection: { mode: "pinned", pinnedModel: "gpt-5" },
      installedProviders: [{ providerId: "openai", installedAt: 1 }],
      providerModelPreferences: {
        openai: "openai/gpt-5",
      },
    } as any);

    expect(reconciled.modelSelection).toEqual({ mode: "auto" });
    expect(reconciled.model).toBeUndefined();
    expect(
      resolveEffectiveModelRef({
        modelSelection: reconciled.modelSelection,
        installedProviders: [{ providerId: "openai", installedAt: 1 }],
        providerModelPreferences: reconciled.providerModelPreferences,
      } as any)
    ).toBe("openai/gpt-5");
  });
});

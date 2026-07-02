import { describe, expect, test } from "bun:test";
import { validateCapabilityBlock } from "../../lobu/stores/provider-secrets.js";

// The app-layer validator is the full guard on top of the DB CHECK floor. It
// MUST reject every bypass class the DB CHECK catches (and more), so a write
// path that goes through the store can never persist an exfil-capable block.
describe("validateCapabilityBlock — base_url", () => {
  test("accepts a clean https base_url", () => {
    expect(
      validateCapabilityBlock("text", { base_url: "https://vllm.acme/v1" })
    ).toBeNull();
  });

  test.each([
    ["http (not https)", { base_url: "http://vllm.acme/v1" }],
    ["userinfo user:pass@", { base_url: "https://u:p@evil/v1" }],
    ["query string", { base_url: "https://vllm.acme/v1?x=1" }],
    ["fragment", { base_url: "https://vllm.acme/v1#f" }],
    ["not a URL", { base_url: "://nope" }],
    ["empty string", { base_url: "" }],
  ])("rejects base_url: %s", (_label, block) => {
    expect(validateCapabilityBlock("text", block)).not.toBeNull();
  });
});

describe("validateCapabilityBlock — models_endpoint (matches DB CHECK)", () => {
  test.each([
    ["clean path", { models_endpoint: "/v1/models" }],
    ["root", { models_endpoint: "/" }],
  ])("accepts models_endpoint: %s", (_label, block) => {
    expect(validateCapabilityBlock("text", block)).toBeNull();
  });

  test.each([
    ["protocol-relative //evil", { models_endpoint: "//evil/models" }],
    ["absolute URL", { models_endpoint: "https://evil/models" }],
    ["backslash", { models_endpoint: "/a\\b" }],
    ["no leading slash", { models_endpoint: "models" }],
    ["tab-injected", { models_endpoint: "/\t//evil" }],
    ["space", { models_endpoint: "/a b" }],
    ["non-string", { models_endpoint: 42 }],
  ])("rejects models_endpoint: %s", (_label, block) => {
    expect(validateCapabilityBlock("text", block)).not.toBeNull();
  });
});

describe("validateCapabilityBlock — model + shape", () => {
  test("accepts a non-empty model", () => {
    expect(validateCapabilityBlock("image", { model: "gpt-image-1" })).toBeNull();
  });
  test("rejects empty model", () => {
    expect(validateCapabilityBlock("image", { model: "  " })).not.toBeNull();
  });
  test("rejects unknown field in a block", () => {
    expect(
      validateCapabilityBlock("text", { api_key_ref: "secret://x" })
    ).not.toBeNull();
  });
  test("rejects a non-object block", () => {
    expect(validateCapabilityBlock("text", "https://evil")).not.toBeNull();
    expect(validateCapabilityBlock("text", 5)).not.toBeNull();
    expect(validateCapabilityBlock("text", ["x"])).not.toBeNull();
  });
  test("rejects an unknown modality", () => {
    expect(validateCapabilityBlock("video", { model: "x" })).not.toBeNull();
  });
  test("accepts an empty block", () => {
    expect(validateCapabilityBlock("text", {})).toBeNull();
  });
});

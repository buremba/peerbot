import { describe, expect, test } from "bun:test";
import {
  detectToolIntentRules,
  getCustomToolDescription,
  renderDetectedToolIntentRules,
} from "../agent-policy";

describe("agent-policy file delivery guidance", () => {
  test("detects file delivery prompts and prioritizes upload_file", () => {
    const rules = detectToolIntentRules(
      "Create a PDF summary and send the file to me as an attachment"
    );

    expect(rules.map((rule) => rule.id)).toContain("file-delivery");
    expect(rules.some((rule) => rule.tools.includes("upload_file"))).toBe(true);
  });

  test("renders explicit create-then-upload guidance for file delivery", () => {
    const instructions = renderDetectedToolIntentRules(
      "Export this as a CSV and upload the file for me to download"
    );

    expect(instructions).toContain("Deliver Files To The User");
    expect(instructions).toContain("upload_file");
    expect(instructions).toContain(
      "create the file, call upload_file, then tell the user it was sent"
    );
  });

  test("upload_file description forbids local path substitutes", () => {
    expect(getCustomToolDescription("upload_file")).toContain(
      "Do not substitute local paths, workspace paths, or sandbox links"
    );
  });
});

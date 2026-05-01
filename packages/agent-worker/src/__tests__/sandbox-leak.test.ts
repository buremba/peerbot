/**
 * Unit tests for the sandbox-leak detector. These cover the false-positive
 * cases that broke the Slack "probe" response (descriptive path mentions
 * got nuked) plus the true-positive cases we still need to catch.
 */

import { describe, expect, test } from "bun:test";
import { checkSandboxLeak } from "../openclaw/sandbox-leak";

describe("checkSandboxLeak", () => {
  test("passes through empty input", () => {
    const res = checkSandboxLeak("", false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe("");
  });

  test("suppresses check when UploadUserFile event was seen", () => {
    const text =
      "Here is your report. Also my notes live at /app/workspaces/foo/bar.md.";
    const res = checkSandboxLeak(text, true);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("allows descriptive probe response mentioning workspace path", () => {
    const text = [
      "## Workspace Probe Results",
      "",
      "**Workspace Location:** `/app/workspaces/careops/C09EH3ASNQ1`",
      "",
      "**Directory Structure:**",
      "- `.openclaw/` - Configuration files",
      "- `input/` - Empty",
    ].join("\n");
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("allows /workspace/ path in plain prose", () => {
    const text =
      "I inspected /workspace/careops and it contains three directories.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });

  test("flags sandbox:// URL as delivery claim", () => {
    const text = "Here is your file: sandbox:/output/report.pdf";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("sandbox:/output/report.pdf");
    expect(res.redactedText).toContain("[local file, not uploaded]");
    expect(res.redactedText).toContain("did not actually upload");
  });

  test("flags sandbox:// URL with double-slash form", () => {
    const text = "Download: sandbox://workspace/x.csv";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("sandbox://workspace/x.csv");
  });

  test("flags markdown link to /app/workspaces/ as delivery claim", () => {
    const text =
      "Your report is ready: [report.pdf](/app/workspaces/foo/report.pdf)";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("/app/workspaces/foo/report.pdf");
    expect(res.redactedText).toContain("](about:blank)");
    expect(res.redactedText).toContain("did not actually upload");
  });

  test("flags markdown link with file:// scheme", () => {
    const text = "Download [here](file:///workspace/out.csv).";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("file:///workspace/out.csv");
  });

  test("flags HTML href pointing at workspace path", () => {
    const text = '<a href="/app/workspaces/foo/bar.pdf">click</a>';
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).toContain('href="about:blank"');
    expect(res.redactedText).not.toContain("/app/workspaces/foo/bar.pdf");
  });

  test("flags HTML src preserving attribute name", () => {
    const text = '<img src="/workspace/chart.png" />';
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).toContain('src="about:blank"');
    expect(res.redactedText).not.toContain("/workspace/chart.png");
  });

  test("preserves surrounding prose when redacting", () => {
    const text =
      "Intro paragraph.\n\n[report.pdf](/app/workspaces/x/report.pdf)\n\nClosing remarks.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).toContain("Intro paragraph.");
    expect(res.redactedText).toContain("Closing remarks.");
  });

  test("does not flag bare workspace path in backticks", () => {
    // This is the probe-style case that the broad regex was false-positive on.
    const text = "The workspace is at `/app/workspaces/careops/foo`.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("does not flag non-workspace markdown links", () => {
    const text = "See [docs](https://example.com/path).";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });

  // --- delivery-phrase detection ---

  test("flags 'located at' with workspace file path", () => {
    const text =
      "The file is located at: /app/workspaces/careops/123/input/sample_patient.json";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("/app/workspaces/careops");
    expect(res.redactedText).toContain("not uploaded");
  });

  test("flags 'saved to' with backticked workspace path", () => {
    const text = "Report saved to `/workspace/output/report.pdf` successfully.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).not.toContain("/workspace/output/report.pdf");
  });

  test("does not flag delivery phrase with directory (no extension)", () => {
    const text = "Files are stored in /app/workspaces/careops/123/input";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });

  test("does not flag delivery phrase about non-workspace paths", () => {
    const text = "The file is located at: /home/user/documents/report.pdf";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });

  test("suppresses delivery-phrase check when UploadUserFile was used", () => {
    const text =
      "I saved the file to `/workspace/output/data.csv` and uploaded it.";
    const res = checkSandboxLeak(text, true);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("is stable across repeated invocations (no lastIndex leakage)", () => {
    const bad = "Here: sandbox:/a.pdf";
    const good = "Workspace at /app/workspaces/careops.";
    const deliveryBad = "File saved to /app/workspaces/foo/report.pdf for you.";
    expect(checkSandboxLeak(bad, false).leaked).toBe(true);
    expect(checkSandboxLeak(good, false).leaked).toBe(false);
    expect(checkSandboxLeak(deliveryBad, false).leaked).toBe(true);
    expect(checkSandboxLeak(bad, false).leaked).toBe(true);
    expect(checkSandboxLeak(good, false).leaked).toBe(false);
  });
});

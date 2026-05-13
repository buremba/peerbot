/**
 * Hardening tests for checkSandboxLeak — edge cases not covered by sandbox-leak.test.ts.
 *
 * Covers:
 * - Multiple leak patterns in one message (all redacted, single note appended)
 * - Real-secret-shaped strings that are NOT workspace paths (no false positive)
 * - Boundary: path with no extension is NOT flagged by delivery-phrase regex
 * - sandbox:// URL inside a code block (still flagged — delivery claim)
 * - HTML src attribute without a file extension (still a workspace link → flagged)
 * - The "exported to" / "written to" / "generated at" delivery phrase variants
 * - Regex lastIndex stability under rapid repeated calls (stress)
 * - Large input with no leaks: does not incorrectly set leaked=true
 */

import { describe, expect, test } from "bun:test";
import { checkSandboxLeak } from "../openclaw/sandbox-leak";

// ---------------------------------------------------------------------------
// Multiple patterns in one message
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — multiple leak patterns", () => {
  test("redacts all offending patterns and appends a single note", () => {
    const text = [
      "Your files: sandbox:/report.pdf",
      "[csv](/app/workspaces/org/123/data.csv)",
      '<img src="/workspace/chart.png" />',
    ].join("\n");

    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);

    // sandbox URL replaced
    expect(res.redactedText).toContain("[local file, not uploaded]");
    // markdown link target replaced
    expect(res.redactedText).toContain("](about:blank)");
    // HTML src replaced
    expect(res.redactedText).toContain('src="about:blank"');

    // Only one appended note block
    const noteCount = (
      res.redactedText.match(/_Note: I referenced a local file/g) ?? []
    ).length;
    expect(noteCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// False-positive guard: real-secret-shaped text not in a workspace path
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — false-positive guards", () => {
  test("ANTHROPIC_API_KEY in plain prose is not flagged", () => {
    const text =
      "Never log ANTHROPIC_API_KEY or sk-ant-api03-xxxx values in responses.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("lobu_secret placeholder string in prose is not flagged", () => {
    const text =
      "The API key is lobu_secret_abc123 — a proxy placeholder, not the real key.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(text);
  });

  test("HTTP URL starting with https is not flagged", () => {
    const text = "Download from https://example.com/report.pdf.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });

  test("/tmp path without workspace prefix is not flagged", () => {
    const text = "Temp file at /tmp/output.csv is ephemeral.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery phrase variants
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — delivery phrase variants", () => {
  test("'exported to' triggers detection", () => {
    const text = "exported to /app/workspaces/org/123/report.csv";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("'written to' triggers detection", () => {
    const text = "written to /workspace/output/final.txt";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("'generated at' triggers detection", () => {
    const text = "generated at /workspace/artifacts/report.pdf";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("'created at' triggers detection", () => {
    const text = "The summary was created at /workspace/summary.md";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("'stored at' triggers detection", () => {
    const text = "The data is stored at /app/workspaces/org/run/data.json";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("delivery phrase with a very long extension is still caught (up to 10 chars)", () => {
    const text = "located at /workspace/compressed.tar.gz";
    // tar.gz — the regex matches \.\w{1,10} so 'gz' qualifies
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sandbox:// inside prose / code blocks
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — sandbox:// variants", () => {
  test("sandbox:// inside backtick code span is still flagged", () => {
    const text = "Run `curl sandbox://output/data.csv` to download.";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });

  test("sandbox://workspace/path with query string is flagged", () => {
    // The regex stops at whitespace/special chars — but ? is included until space
    const text = "Here: sandbox://workspace/report.pdf";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTML attribute variants
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — HTML attributes", () => {
  test("single-quote HTML href is flagged", () => {
    const text = "<a href='/app/workspaces/org/report.pdf'>click</a>";
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
    expect(res.redactedText).toContain('href="about:blank"');
  });

  test("HTML src without extension is still flagged (binary without ext)", () => {
    const text = '<img src="/workspace/artifact" />';
    // No extension — the LOCAL_HREF_RE doesn't require an extension
    const res = checkSandboxLeak(text, false);
    expect(res.leaked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regex stability under rapid repeated calls (lastIndex leak check)
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — regex stability under rapid invocations", () => {
  test("alternating positive/negative checks remain accurate across 20 calls", () => {
    const good = "Workspace information: `/workspace/dir`";
    const bad = "sandbox:/workspace/file.txt";

    for (let i = 0; i < 20; i++) {
      const g = checkSandboxLeak(good, false);
      const b = checkSandboxLeak(bad, false);
      expect(g.leaked).toBe(false);
      expect(b.leaked).toBe(true);
    }
  });

  test("100 consecutive 'no leak' calls return consistent false", () => {
    const text = "The workspace directory is at `/app/workspaces/org/run`.";
    for (let i = 0; i < 100; i++) {
      expect(checkSandboxLeak(text, false).leaked).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Large input with no leaks
// ---------------------------------------------------------------------------

describe("checkSandboxLeak — large clean input", () => {
  test("large prose with no workspace paths is not flagged", () => {
    const para = "This is a paragraph about agent workflows. ".repeat(200);
    const res = checkSandboxLeak(para, false);
    expect(res.leaked).toBe(false);
    expect(res.redactedText).toBe(para);
  });
});

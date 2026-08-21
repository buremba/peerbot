import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  automationAttachCommand,
  automationAttachmentsCommand,
  automationDetachCommand,
} from "../commands/automation.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "lobu-cli-attachment-test-"));
  roots.push(root);
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir);
  const pid = 1357;
  const procStart = "Fri Aug 21 00:02:00 2026";
  const sessionId = "cli-session";
  writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart,
      peerProtocol: 1,
      kind: "interactive",
      messagingSocketPath: path.join(root, "claude.sock"),
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    path.join(sessionsDir, `${pid}.fixture.key`),
    JSON.stringify({ peerToken: "peer-token", procStart }),
    { mode: 0o600 }
  );
  return {
    attachmentsFile: path.join(root, "attachments.json"),
    sessionId,
    resolver: {
      sessionsDir,
      processStart: () => procStart,
      socketStat: () => ({
        isSocket: () => true,
        uid: process.getuid?.() ?? 0,
      }),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("lobu automation local attachment commands", () => {
  test("requires Claude session context unless --session-id is explicit", async () => {
    await expect(automationAttachCommand("7", {}, { env: {} })).rejects.toThrow(
      "Run this command inside Claude Code"
    );
  });

  test("attaches exactly, reports status, and detaches without remote mutation", async () => {
    const f = fixture();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    try {
      await automationAttachCommand(
        "7",
        {},
        {
          env: { CLAUDE_CODE_SESSION_ID: f.sessionId },
          attachmentsFile: f.attachmentsFile,
          sessionResolver: f.resolver,
        }
      );
      await automationAttachmentsCommand({
        attachmentsFile: f.attachmentsFile,
        sessionResolver: f.resolver,
      });
      await automationDetachCommand("7", {
        attachmentsFile: f.attachmentsFile,
      });
    } finally {
      log.mockRestore();
    }
    expect(lines.join("\n")).toContain(`7\t${f.sessionId}\tonline`);
    expect(lines.join("\n")).toContain("standalone `lobu daemon`");
    expect(lines.join("\n")).toContain(
      "must already be pinned to this Lobu device"
    );
    expect(lines.join("\n")).toContain(
      "No remote Automation or device pin was changed"
    );
  });

  test("--session-id overrides the Claude environment value", async () => {
    const f = fixture();
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await automationAttachCommand(
        "8",
        { sessionId: f.sessionId },
        {
          env: { CLAUDE_CODE_SESSION_ID: "wrong-session" },
          attachmentsFile: f.attachmentsFile,
          sessionResolver: f.resolver,
        }
      );
    } finally {
      log.mockRestore();
    }
    const stored = JSON.parse(readFileSync(f.attachmentsFile, "utf8"));
    expect(stored.attachments).toEqual({ "8": f.sessionId });
  });
});

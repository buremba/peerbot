import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts/sparkle/update-appcast.py");
const macInfoPlist = join(
  repoRoot,
  "packages/owletto/apps/mac/Owletto/Info.plist"
);
const temporaryDirectories: string[] = [];
const owlettoSubmoduleStubbed =
  process.env.OWLETTO_SUBMODULE_STUBBED === "true";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Sparkle updater freshness", () => {
  it("orders releases by timestamp rather than weekday text", () => {
    const directory = mkdtempSync(join(tmpdir(), "lobu-appcast-test-"));
    temporaryDirectories.push(directory);
    const appcast = join(directory, "appcast.xml");
    writeFileSync(
      appcast,
      `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <title>Owletto</title>
    <item>
      <pubDate>Wed, 29 Jul 2026 18:12:51 GMT</pubDate>
      <sparkle:version>14.7.1</sparkle:version>
      <sparkle:shortVersionString>14.7.1</sparkle:shortVersionString>
    </item>
    <item>
      <pubDate>Fri, 21 Aug 2026 19:17:02 GMT</pubDate>
      <sparkle:version>15.7.0</sparkle:version>
      <sparkle:shortVersionString>15.7.0</sparkle:shortVersionString>
    </item>
  </channel>
</rss>`
    );

    const result = spawnSync(
      "python3",
      [
        script,
        appcast,
        "--version",
        "17.0.0",
        "--build",
        "17.0.0",
        "--dmg-url",
        "https://example.test/Owletto.dmg",
        "--signature",
        "test-signature",
        "--length",
        "1",
      ],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    const versions = [
      ...readFileSync(appcast, "utf8").matchAll(
        /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/g
      ),
    ].map((match) => match[1]);
    expect(versions).toEqual(["17.0.0", "15.7.0", "14.7.1"]);
  });

  it.skipIf(owlettoSubmoduleStubbed)(
    "checks unattended device workers every hour",
    () => {
      const plist = readFileSync(macInfoPlist, "utf8");
      expect(plist).toMatch(
        /<key>SUScheduledCheckInterval<\/key>\s*<integer>3600<\/integer>/
      );
    }
  );
});

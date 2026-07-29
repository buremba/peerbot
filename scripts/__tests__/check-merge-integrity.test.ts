import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import {
  CANONICAL_BASE,
  checkBaseBranch,
  classifyMergedPrs,
  STACKED_PR_LABEL,
} from "../check-merge-integrity.mjs";

const SCRIPT = fileURLToPath(
  new URL("../check-merge-integrity.mjs", import.meta.url)
);

function runReach(pr: {
  number: number;
  title: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  state: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "merge-integrity-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  const git = join(bin, "git");
  writeFileSync(
    git,
    `#!/usr/bin/env node
const [command, flag, sha] = process.argv.slice(2);
if (command === "fetch") process.exit(0);
if (command === "merge-base" && flag === "--is-ancestor") {
  process.exit(sha === "on-main" ? 0 : 1);
}
process.exit(2);
`
  );
  chmodSync(git, 0o755);

  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node
process.stdout.write(process.env.FAKE_PR_JSON ?? "");
`
  );
  chmodSync(gh, 0o755);

  try {
    return spawnSync(
      process.execPath,
      [SCRIPT, "reach", "--pr", `${pr.number}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_PR_JSON: JSON.stringify(pr),
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * PR #2273 was opened against `feat/nix-deny-list-gap`. Squashing that base
 * away left GitHub reporting #2273 as MERGED while its commits never reached
 * `main` — issue #2279 stayed open describing the bug the PR claimed to fix,
 * and every required check had been green. These pin both halves of the gate:
 * refuse the non-main base up front, and catch an unreachable merge commit
 * after the fact.
 */
describe("checkBaseBranch", () => {
  it("accepts main", () => {
    expect(checkBaseBranch(CANONICAL_BASE, [])).toMatchObject({ ok: true });
  });

  it("rejects a non-main base — the #2273 shape", () => {
    const result = checkBaseBranch("feat/nix-deny-list-gap", []);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("feat/nix-deny-list-gap");
    expect(result.reason).toContain("#2273");
  });

  it("lets an explicit stacked-pr label through", () => {
    expect(checkBaseBranch("feat/parent", [STACKED_PR_LABEL])).toMatchObject({
      ok: true,
    });
  });

  it("ignores unrelated labels", () => {
    expect(checkBaseBranch("feat/parent", ["bug", "security"]).ok).toBe(false);
  });
});

describe("classifyMergedPrs", () => {
  const onMain = {
    number: 2285,
    title: "on main",
    baseRefName: "main",
    mergeCommit: { oid: "aaa" },
  };
  const lost = {
    number: 2273,
    title: "merged but absent",
    baseRefName: "feat/nix-deny-list-gap",
    mergeCommit: { oid: "cb85c1ef" },
  };

  it("separates reachable from unreachable merge commits", () => {
    const result = classifyMergedPrs(
      [onMain, lost],
      (sha: string) => sha === "aaa"
    );
    expect(result.ok.map((p: { number: number }) => p.number)).toEqual([2285]);
    expect(result.lost.map((p: { number: number }) => p.number)).toEqual([
      2273,
    ]);
    expect(result.unknown).toEqual([]);
  });

  it("passes nothing when every merge commit is reachable", () => {
    const result = classifyMergedPrs([onMain], () => true);
    expect(result.lost).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("surfaces a merged PR with no merge commit rather than passing it", () => {
    // Silence here is what let #2273 read as shipped; an absent SHA must not
    // be treated as "nothing to check".
    const result = classifyMergedPrs(
      [{ number: 1, title: "no sha", baseRefName: "main", mergeCommit: null }],
      () => true
    );
    expect(result.unknown).toHaveLength(1);
    expect(result.ok).toEqual([]);
    expect(result.passed).toBe(false);
  });
});

describe("CLI", () => {
  it("exits 1 and annotates when the base is not main", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "base", "--base", "feat/nix-deny-list-gap"],
      { encoding: "utf8" }
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("::error::");
    expect(run.stderr).toContain(STACKED_PR_LABEL);
  });

  it("exits 0 for a main-based PR", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "base", "--base", "main"],
      {
        encoding: "utf8",
      }
    );
    expect(run.status).toBe(0);
  });

  it("accepts the exact stacked-pr label from workflow JSON", () => {
    const run = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "base",
        "--base",
        "feat/parent",
        "--labels-json",
        '["stacked-pr"]',
      ],
      { encoding: "utf8" }
    );
    expect(run.status).toBe(0);
  });

  it("does not split a comma inside a label name", () => {
    const run = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "base",
        "--base",
        "feat/parent",
        "--labels-json",
        '["triage,stacked-pr"]',
      ],
      { encoding: "utf8" }
    );
    expect(run.status).toBe(1);
  });

  it("exits 2 on an unknown mode rather than passing silently", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "nonsense"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
  });

  it("requires reach to name a PR or an explicit sweep", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "reach"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("exactly one of --pr or --sweep");
  });
});

describe("reach CLI", () => {
  const pr = {
    number: 1,
    title: "merged change",
    baseRefName: "main",
    mergeCommit: { oid: "on-main" },
    state: "MERGED",
  };

  it("passes when the recorded merge commit is on main", () => {
    const run = runReach(pr);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 on main, 0 missing");
  });

  it("fails when the recorded merge commit is absent from main", () => {
    const run = runReach({
      ...pr,
      baseRefName: "feat/parent",
      mergeCommit: { oid: "missing" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not reachable from origin/main");
  });

  it("fails closed when GitHub records no merge commit", () => {
    const run = runReach({ ...pr, mergeCommit: null });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot be verified");
  });

  it("rejects a PR that GitHub does not report as merged", () => {
    const run = runReach({ ...pr, state: "OPEN" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is OPEN, not MERGED");
  });
});

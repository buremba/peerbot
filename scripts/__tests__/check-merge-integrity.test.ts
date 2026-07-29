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
  ACKNOWLEDGED_LABEL,
  CANONICAL_BASE,
  checkBaseBranch,
  classifyMergedPrs,
  partitionAcknowledged,
  STACKED_PR_LABEL,
} from "../check-merge-integrity.mjs";

const SCRIPT = fileURLToPath(
  new URL("../check-merge-integrity.mjs", import.meta.url)
);

/**
 * #2273's merge commit is gone for good, so the sweep would flag it every day
 * forever. A permanently red alarm is one nobody reads — which is the exact
 * failure this whole gate exists to prevent — so a known-lost PR can be retired
 * by an explicit human label, and never by the script deciding on its own.
 */
describe("partitionAcknowledged", () => {
  const plain = { number: 1, labels: [{ name: "bug" }] };
  const retired = {
    number: 2273,
    labels: [{ name: "bug" }, { name: ACKNOWLEDGED_LABEL }],
  };

  it("retires only PRs carrying the label", () => {
    const { kept, acknowledged } = partitionAcknowledged([plain, retired]);
    expect(kept.map((p: { number: number }) => p.number)).toEqual([1]);
    expect(acknowledged.map((p: { number: number }) => p.number)).toEqual([
      2273,
    ]);
  });

  it("keeps a PR with no labels at all", () => {
    const { kept, acknowledged } = partitionAcknowledged([{ number: 9 }]);
    expect(kept).toHaveLength(1);
    expect(acknowledged).toEqual([]);
  });

  it("does not match a label that merely contains the name", () => {
    const { acknowledged } = partitionAcknowledged([
      { number: 3, labels: [{ name: `not-${ACKNOWLEDGED_LABEL}` }] },
    ]);
    expect(acknowledged).toEqual([]);
  });
});

/**
 * Drives the real CLI with `git` and `gh` faked on PATH. `reach --pr` reads a
 * single object from the fake `gh`; `reach --sweep` reads an array from the
 * same place, so both modes share one harness.
 */
function runCli(
  args: string[],
  fakeJson: unknown
): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "merge-integrity-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  const git = join(bin, "git");
  writeFileSync(
    git,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const [command, flag] = args;
const sha = command === "rev-parse" ? args[3] : args[2];
if (command === "fetch") process.exit(0);
if (command === "rev-parse" && flag === "--verify") {
  if (String(sha).startsWith("probe-failed")) process.exit(128);
  process.exit(String(sha).startsWith("gone") ? 1 : 0);
}
if (command === "merge-base" && flag === "--is-ancestor") {
  if (String(sha).startsWith("gone")) process.exit(128);
  if (String(sha).startsWith("probe-failed")) process.exit(128);
  if (String(sha) === "signaled") process.kill(process.pid, "SIGTERM");
  if (String(sha) === "brokenrepo") process.exit(128);
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
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_PR_JSON: JSON.stringify(fakeJson),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runReach(pr: {
  number: number;
  title: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  state: string;
}) {
  return runCli(["reach", "--pr", `${pr.number}`], pr);
}

function runSweep(
  prs: Array<{
    number: number;
    title: string;
    baseRefName: string;
    mergeCommit: { oid: string } | null;
    labels?: Array<{ name: string }>;
  }>
) {
  return runCli(["reach", "--sweep", "--limit", "50"], prs);
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

  it("reports a missing merge commit object instead of crashing", () => {
    const run = runReach({
      ...pr,
      baseRefName: "feat/deleted-base",
      mergeCommit: { oid: "gone-cb85c1ef" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not reachable from origin/main");
    expect(run.stderr).not.toContain("ENOENT");
    expect(run.stderr).not.toContain("at classifyMergedPrs");
  });

  it("still crashes loudly when git fails but the object exists", () => {
    const run = runReach({ ...pr, mergeCommit: { oid: "brokenrepo" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Command failed");
    expect(run.stderr).not.toContain("is not reachable from origin/main");
  });

  it("still crashes loudly when the object probe itself fails", () => {
    const run = runReach({
      ...pr,
      mergeCommit: { oid: "probe-failed" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Command failed");
    expect(run.stderr).not.toContain("is not reachable from origin/main");
  });

  it("still crashes loudly when git is terminated by a signal", () => {
    const run = runReach({ ...pr, mergeCommit: { oid: "signaled" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Command failed");
    expect(run.stderr).not.toContain("is not reachable from origin/main");
  });
});

/**
 * The sweep is what runs unattended at 13:00, so the acknowledgement path has
 * to be exercised through the CLI and not only as a helper: a label that
 * retired every PR, or none, would look identical at the unit level.
 */
describe("reach --sweep CLI", () => {
  const onMain = {
    number: 2295,
    title: "landed",
    baseRefName: "main",
    mergeCommit: { oid: "on-main" },
  };
  const lost = {
    number: 2273,
    title: "merged but absent",
    baseRefName: "feat/nix-deny-list-gap",
    mergeCommit: { oid: "gone-cb85c1ef" },
  };
  const otherLost = {
    number: 9999,
    title: "also absent",
    baseRefName: "feat/other",
    mergeCommit: { oid: "gone-deadbeef" },
  };

  it("fails and names an unreachable PR", () => {
    const run = runSweep([onMain, lost]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("1 on main, 1 missing");
    expect(run.stderr).toContain("#2273");
  });

  it("passes once the only unreachable PR is acknowledged, and says so", () => {
    const run = runSweep([
      onMain,
      { ...lost, labels: [{ name: ACKNOWLEDGED_LABEL }] },
    ]);
    expect(run.status).toBe(0);
    // Never a silent skip — the run must state what it retired.
    expect(run.stdout).toContain(ACKNOWLEDGED_LABEL);
    expect(run.stdout).toContain("#2273");
  });

  it("retires ONLY the labelled PR — another lost PR still fails the run", () => {
    const run = runSweep([
      onMain,
      { ...lost, labels: [{ name: ACKNOWLEDGED_LABEL }] },
      otherLost,
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("#9999");
    expect(run.stderr).not.toContain("#2273");
  });

  it("does not retire on a near-miss label name", () => {
    const run = runSweep([
      { ...lost, labels: [{ name: `not-${ACKNOWLEDGED_LABEL}` }] },
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("#2273");
  });
});

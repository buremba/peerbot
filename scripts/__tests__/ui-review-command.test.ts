import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { approvalCommand, buildProofBody } from "../lib/ui-review-proof";

const UI_REVIEW_SCRIPT = resolve(import.meta.dir, "..", "ui-review.ts");
const BASE_POINTER = "1".repeat(40);
const HEAD_POINTER = "2".repeat(40);
const BASE_COMMIT = "a".repeat(40);

interface MockState {
  comments: Record<string, Array<Record<string, unknown>>>;
  calls: Array<{
    endpoint: string;
    method: string;
    payload: Record<string, unknown>;
  }>;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function command(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function createFixture(): {
  repo: string;
  bin: string;
  stateFile: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "lobu-ui-review-test-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const stateFile = join(root, "state.json");
  command(root, ["git", "init", "-q", repo]);
  command(repo, ["git", "config", "user.email", "test@example.com"]);
  command(repo, ["git", "config", "user.name", "Test"]);
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "packages/owletto"]\n\tpath = packages/owletto\n\turl = https://github.com/lobu-ai/owletto.git\n'
  );
  command(repo, ["git", "add", ".gitmodules"]);
  command(repo, ["git", "commit", "-q", "-m", "fixture"]);
  const head = command(repo, ["git", "rev-parse", "HEAD"]);
  writeFileSync(
    stateFile,
    JSON.stringify({ comments: {}, calls: [] } satisfies MockState)
  );
  command(root, ["mkdir", "-p", bin]);

  const mockGh = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const stateFile = process.env.MOCK_STATE_FILE;
const state = JSON.parse(await Bun.file(stateFile).text());
const writeState = () => Bun.write(stateFile, JSON.stringify(state));
const output = (value) => process.stdout.write(JSON.stringify(value));

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("lobu-ai/lobu");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  output({
    number: 2500,
    url: "https://github.com/lobu-ai/lobu/pull/2500",
    baseRefOid: process.env.MOCK_BASE_COMMIT,
    headRefOid: process.env.MOCK_HEAD_COMMIT,
  });
  process.exit(0);
}
if (args[0] !== "api") process.exit(90);

const endpoint = args.find((arg) => arg.startsWith("repos/"));
const methodIndex = args.indexOf("-X");
const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];
const input = await new Response(Bun.stdin.stream()).text();
const payload = input ? JSON.parse(input) : {};
state.calls.push({ endpoint, method, payload });

if (
  process.env.MOCK_FAIL_OWLETTO_COMMENTS === "1" &&
  endpoint === "repos/lobu-ai/owletto/issues/712/comments" &&
  method === "GET"
) {
  await writeState();
  console.error("mock comments failure");
  process.exit(92);
}

if (endpoint.includes("/contents/packages/owletto?ref=")) {
  const sha = endpoint.endsWith(process.env.MOCK_BASE_COMMIT)
    ? process.env.MOCK_BASE_POINTER
    : process.env.MOCK_HEAD_POINTER;
  output({ type: "submodule", sha });
} else if (endpoint.includes("/commits/") && endpoint.endsWith("/pulls")) {
  output([{
    number: 712,
    html_url: "https://github.com/lobu-ai/owletto/pull/712",
    merge_commit_sha: process.env.MOCK_HEAD_POINTER,
    merged_at: "2026-08-04T10:00:00Z",
  }]);
} else if (endpoint.includes("/collaborators/") && endpoint.endsWith("/permission")) {
  output({ permission: "admin" });
} else if (endpoint.includes("/statuses/") && method === "POST") {
  output(payload);
} else if (new RegExp("/issues/[0-9]+/comments$").test(endpoint)) {
  if (method === "GET") {
    output([state.comments[endpoint] || []]);
  } else {
    const comments = state.comments[endpoint] || [];
    const comment = {
      id: 1000 + comments.length,
      body: payload.body,
      created_at: "2026-08-04T12:00:00Z",
      updated_at: "2026-08-04T12:00:00Z",
      html_url: "https://github.com/comment/" + (1000 + comments.length),
      user: { login: "agent" },
    };
    comments.push(comment);
    state.comments[endpoint] = comments;
    output(comment);
  }
} else if (new RegExp("/issues/comments/[0-9]+$").test(endpoint) && method === "PATCH") {
  const id = Number(endpoint.split("/").at(-1));
  let found;
  for (const comments of Object.values(state.comments)) {
    const comment = comments.find((candidate) => candidate.id === id);
    if (comment) {
      comment.body = payload.body;
      comment.updated_at = "2026-08-04T12:00:00Z";
      found = comment;
    }
  }
  output(found);
} else {
  console.error("unhandled mock gh call", method, endpoint);
  process.exit(91);
}
await writeState();
`;
  writeFileSync(join(bin, "gh"), mockGh);
  chmodSync(join(bin, "gh"), 0o755);
  return { repo, bin, stateFile, head };
}

function runUiReview(
  fixture: ReturnType<typeof createFixture>,
  environment: Record<string, string> = {}
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", UI_REVIEW_SCRIPT], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_STATE_FILE: fixture.stateFile,
      MOCK_BASE_COMMIT: BASE_COMMIT,
      MOCK_HEAD_COMMIT: fixture.head,
      MOCK_BASE_POINTER: BASE_POINTER,
      MOCK_HEAD_POINTER: HEAD_POINTER,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readState(path: string): MockState {
  return JSON.parse(readFileSync(path, "utf8")) as MockState;
}

function expectExit(
  result: ReturnType<typeof Bun.spawnSync>,
  expected: number
): void {
  if (result.exitCode !== expected) {
    throw new Error(
      `expected exit ${expected}, got ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`
    );
  }
}

describe("ui-review command", () => {
  it("clears stale parent copy when the Owletto pointer no longer changes", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const parentEndpoint = "repos/lobu-ai/lobu/issues/2500/comments";
    state.comments[parentEndpoint] = [
      {
        id: 900,
        body: "<!-- lobu-ui-review-marker -->\n**UI review awaiting approval**",
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/900",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));
    const result = runUiReview(fixture, { MOCK_BASE_POINTER: HEAD_POINTER });

    expectExit(result, 0);
    const finalState = readState(fixture.stateFile);
    const status = finalState.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "success",
      description: "No Owletto pointer change",
    });
    expect(finalState.comments[parentEndpoint]?.[0]?.body).toContain(
      "**UI review not applicable**"
    );
  });

  it("does not add a parent comment when UI review was never applicable", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, { MOCK_BASE_POINTER: HEAD_POINTER });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);
    expect(state.comments["repos/lobu-ai/lobu/issues/2500/comments"]).toBe(
      undefined
    );
  });

  it("replaces an earlier success with pending before reading remote proof", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    state.calls.push({
      endpoint: `repos/lobu-ai/lobu/statuses/${fixture.head}`,
      method: "POST",
      payload: { context: "ui-review", state: "success" },
    });
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/test-proof",
      MOCK_FAIL_OWLETTO_COMMENTS: "1",
    });

    expectExit(result, 2);
    const statuses = readState(fixture.stateFile).calls.filter((call) =>
      call.endpoint.includes("/statuses/")
    );
    expect(statuses.at(-1)?.payload).toMatchObject({
      context: "ui-review",
      state: "pending",
    });
  });

  it("keeps its own proof when another Lobu PR pins the same Owletto commit", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    state.comments[proofEndpoint] = [
      {
        id: 800,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2499,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/other-pr",
        }),
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/800",
        user: { login: "agent" },
      },
      {
        id: 801,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2500,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/ours",
        }),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
        html_url: "https://github.com/comment/801",
        user: { login: "agent" },
      },
      {
        id: 802,
        body: approvalCommand(HEAD_POINTER),
        created_at: "2026-08-04T12:01:00Z",
        updated_at: "2026-08-04T12:01:00Z",
        html_url: "https://github.com/comment/802",
        user: { login: "buremba" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture);

    expectExit(result, 0);
    const finalState = readState(fixture.stateFile);
    expect(
      finalState.calls
        .filter((call) => call.endpoint.includes("/statuses/"))
        .at(-1)?.payload
    ).toMatchObject({ context: "ui-review", state: "success" });
    expect(finalState.comments[proofEndpoint]?.[0]?.body).toContain(
      "https://claude.ai/code/artifact/other-pr"
    );
  });

  it("adds its proof beside another PR's instead of overwriting it", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    state.comments[proofEndpoint] = [
      {
        id: 800,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2499,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/other-pr",
        }),
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/800",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/ours",
    });

    expectExit(result, 3);
    const comments = readState(fixture.stateFile).comments[proofEndpoint] ?? [];
    expect(comments[0]?.body).toContain(
      "https://claude.ai/code/artifact/other-pr"
    );
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("https://claude.ai/code/artifact/ours");
  });

  it("stays pending until a later exact approval comment, then passes", () => {
    const fixture = createFixture();
    const pending = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/test-proof",
    });

    expectExit(pending, 3);
    let state = readState(fixture.stateFile);
    const pendingStatus = state.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(pendingStatus?.payload).toMatchObject({
      context: "ui-review",
      state: "pending",
    });
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    const proof = state.comments[proofEndpoint]?.[0];
    expect(proof?.body).toContain("<!-- lobu-ui-review-proof ");

    state.comments[proofEndpoint].push({
      id: 2000,
      body: approvalCommand(HEAD_POINTER),
      created_at: "2026-08-04T12:01:00Z",
      updated_at: "2026-08-04T12:01:00Z",
      html_url: "https://github.com/comment/2000",
      user: { login: "buremba" },
    });
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const approved = runUiReview(fixture);
    expectExit(approved, 0);
    state = readState(fixture.stateFile);
    const approvedStatus = state.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(approvedStatus?.payload).toMatchObject({
      context: "ui-review",
      state: "success",
    });
    expect(state.calls.at(-1)?.endpoint).toContain("/statuses/");
  });
});

/**
 * Tool-surface eval runner.
 *
 * For each task × arm × trial: seed a FRESH org with identical starting state,
 * build the arm's glm-4.7 session, run the prompt, collect metrics from the
 * agent event stream, then run the deterministic state + reply checks.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/lobu_test \
 *   Z_AI_API_KEY=... bun run.ts [--trials N] [--tasks id,id] [--arms A,B]
 *
 * Metrics per cell:
 *   - pass / fail (state check, plus reply check for read tasks)
 *   - toolCalls (total), erroredCalls (arg fumbles / handler errors)
 *   - loops (max run of identical consecutive tool calls > 1)
 *   - turns (assistant turns), elapsed ms
 *   - usedLobuSurface (Arm B: did it ever invoke the `lobu` CLI at all?)
 *
 * Real glm-4.7 calls only. No mocked model.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildArmA, buildArmB } from "./arms";
import { ensureMigrated, freshOrg } from "./scenario";
import { replyCheck, TASKS, type EvalTask } from "./tasks";

interface CellMetrics {
  arm: string;
  taskId: string;
  trial: number;
  statePass: boolean;
  replyPass: boolean | null;
  pass: boolean;
  toolCalls: number;
  erroredCalls: number;
  maxIdenticalRun: number;
  turns: number;
  elapsedMs: number;
  usedLobuSurface: boolean | null;
  stateDetail: string;
  replyDetail: string;
  failNote: string;
}

type Arm = "A" | "B";

function parseArgs(): { trials: number; tasks: string[]; arms: Arm[] } {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : def;
  };

  const trials = Number(get("--trials", "3"));
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(
      `--trials must be a positive integer, got "${get("--trials", "3")}"`
    );
  }

  // Validate --arms against the known set rather than casting arbitrary strings
  // to Arm — a typo like "C" would otherwise silently produce empty cells.
  const rawArms = get("--arms", "A,B").split(",").filter(Boolean);
  const arms: Arm[] = [];
  for (const a of rawArms) {
    if (a !== "A" && a !== "B") {
      throw new Error(
        `--arms must be a comma list of A|B, got invalid value "${a}"`
      );
    }
    if (!arms.includes(a)) arms.push(a);
  }
  if (arms.length === 0) {
    throw new Error("--arms produced no valid arms (expected A and/or B)");
  }

  return {
    trials,
    tasks: get("--tasks", "").split(",").filter(Boolean),
    arms,
  };
}

function lastAssistantText(session: {
  agent: { state: { messages: Array<{ role: string; content: unknown }> } };
}): string {
  const msgs = session.agent.state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((b: unknown) => (b as { type?: string }).type === "text")
        .map((b: unknown) => (b as { text?: string }).text ?? "")
        .join(" ");
      if (text.trim()) return text;
    }
  }
  return "";
}

async function runCell(
  arm: "A" | "B",
  task: EvalTask,
  trial: number
): Promise<CellMetrics> {
  const org = await freshOrg(`eval-${arm}-${task.id}-${trial}-${Date.now()}`);
  const seeded = await task.seed(org);

  const ws = `/tmp/lobu-tse/${arm}-${task.id}-${trial}-${Date.now()}`;
  const built = arm === "A" ? await buildArmA(org) : await buildArmB(org, ws);

  // Dispose the session/dispatcher no matter how the cell ends (prompt throw,
  // check throw, timeout). Arm B's dispatcher is a child process — leaking it
  // orphans a Postgres pool per cell.
  try {
    // Metric collection from the live event stream.
    let toolCalls = 0;
    let erroredCalls = 0;
    let turns = 0;
    let usedLobu = false;
    const callSig: string[] = [];
    built.session.subscribe((ev: { type: string; [k: string]: unknown }) => {
      if (ev.type === "tool_execution_start") {
        toolCalls++;
        const name = String(ev.toolName);
        const sig = `${name}:${JSON.stringify(ev.args ?? {})}`;
        callSig.push(sig);
        if (arm === "B" && name === "bash") {
          const cmd = String((ev.args as { command?: string })?.command ?? "");
          if (/\blobu\b/.test(cmd)) usedLobu = true;
        }
      } else if (ev.type === "tool_execution_end") {
        if (ev.isError) erroredCalls++;
      } else if (ev.type === "turn_start") {
        turns++;
      }
    });

    const t0 = Date.now();
    let failNote = "";
    try {
      await Promise.race([
        built.session.prompt(task.prompt(seeded)),
        new Promise((_r, rej) =>
          setTimeout(() => rej(new Error("turn timeout (240s)")), 240_000)
        ),
      ]);
    } catch (err) {
      failNote = err instanceof Error ? err.message : String(err);
    }
    const elapsedMs = Date.now() - t0;

    // Longest run of identical consecutive tool calls (loop/runaway signal).
    let maxIdenticalRun = 1;
    let cur = 1;
    for (let i = 1; i < callSig.length; i++) {
      if (callSig[i] === callSig[i - 1]) {
        cur++;
        maxIdenticalRun = Math.max(maxIdenticalRun, cur);
      } else cur = 1;
    }
    if (callSig.length === 0) maxIdenticalRun = 0;

    const reply = lastAssistantText(built.session);
    const stateRes = await task.check(org, seeded);
    const replyRes = replyCheck(task.id, reply);
    const replyPass = replyRes ? replyRes.pass : null;
    // A task passes if the state check passes AND (no reply check, or it passes).
    const pass = stateRes.pass && (replyPass === null || replyPass === true);

    return {
      arm: built.arm,
      taskId: task.id,
      trial,
      statePass: stateRes.pass,
      replyPass,
      pass,
      toolCalls,
      erroredCalls,
      maxIdenticalRun,
      turns,
      elapsedMs,
      usedLobuSurface: arm === "B" ? usedLobu : null,
      stateDetail: stateRes.detail,
      replyDetail: replyRes?.detail ?? "",
      failNote,
    };
  } finally {
    built.dispose?.();
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((100 * n) / d)}%`;
}

async function main() {
  if (!process.env.Z_AI_API_KEY) {
    console.error(
      "BLOCKER: Z_AI_API_KEY not set — cannot run real glm-4.7. Aborting."
    );
    process.exit(2);
  }
  await ensureMigrated();

  const opts = parseArgs();
  if (opts.tasks.length) {
    const known = new Set(TASKS.map((t) => t.id));
    const unknown = opts.tasks.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `--tasks has unknown id(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`
      );
    }
  }
  const tasks = opts.tasks.length
    ? TASKS.filter((t) => opts.tasks.includes(t.id))
    : TASKS;
  const arms = opts.arms;

  console.log(
    `\n=== Tool-surface eval: glm-4.7 via z-ai ===\n` +
      `arms=${arms.join(",")} tasks=${tasks.map((t) => t.id).join(",")} trials=${opts.trials}\n`
  );

  const all: CellMetrics[] = [];
  for (const arm of arms) {
    for (const task of tasks) {
      for (let trial = 1; trial <= opts.trials; trial++) {
        process.stdout.write(`running ${arm}/${task.id} trial ${trial}... `);
        const m = await runCell(arm, task, trial);
        all.push(m);
        console.log(
          `${m.pass ? "PASS" : "FAIL"} ` +
            `(calls=${m.toolCalls} err=${m.erroredCalls} loop=${m.maxIdenticalRun} ` +
            `turns=${m.turns} ${(m.elapsedMs / 1000).toFixed(0)}s` +
            `${arm === "B" ? ` lobu=${m.usedLobuSurface}` : ""})` +
            `${m.failNote ? ` [${m.failNote}]` : ""}`
        );
      }
    }
  }

  // Per-cell table.
  console.log("\n\n## Per-cell results\n");
  console.log(
    "| arm | task | trial | pass | calls | fumbles | maxLoop | turns | sec | lobu? | detail |"
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of all) {
    const detail =
      `${m.stateDetail}${m.replyDetail ? `; ${m.replyDetail}` : ""}`
        .replace(/\|/g, "/")
        .slice(0, 80);
    console.log(
      `| ${m.arm} | ${m.taskId} | ${m.trial} | ${m.pass ? "✅" : "❌"} | ${m.toolCalls} | ${m.erroredCalls} | ${m.maxIdenticalRun} | ${m.turns} | ${(m.elapsedMs / 1000).toFixed(0)} | ${m.usedLobuSurface ?? "—"} | ${detail} |`
    );
  }

  // Per-arm × task summary.
  console.log("\n\n## Summary by arm × task (pass rate, mean calls/fumbles)\n");
  console.log(
    "| arm | task | pass rate | mean calls | mean fumbles | mean turns |"
  );
  console.log("|---|---|---|---|---|---|");
  for (const arm of arms) {
    const armLabel = arm === "A" ? "A-discrete" : "B-bash-cli";
    for (const task of tasks) {
      const cells = all.filter(
        (m) => m.arm === armLabel && m.taskId === task.id
      );
      if (cells.length === 0) continue;
      const passes = cells.filter((m) => m.pass).length;
      const meanCalls = (
        cells.reduce((s, m) => s + m.toolCalls, 0) / cells.length
      ).toFixed(1);
      const meanErr = (
        cells.reduce((s, m) => s + m.erroredCalls, 0) / cells.length
      ).toFixed(1);
      const meanTurns = (
        cells.reduce((s, m) => s + m.turns, 0) / cells.length
      ).toFixed(1);
      console.log(
        `| ${armLabel} | ${task.id} | ${pct(passes, cells.length)} (${passes}/${cells.length}) | ${meanCalls} | ${meanErr} | ${meanTurns} |`
      );
    }
  }

  // Per-arm overall.
  console.log("\n\n## Overall by arm\n");
  console.log(
    "| arm | pass rate | mean calls | fumble rate | mean turns | mean sec |"
  );
  console.log("|---|---|---|---|---|---|");
  for (const arm of arms) {
    const armLabel = arm === "A" ? "A-discrete" : "B-bash-cli";
    const cells = all.filter((m) => m.arm === armLabel);
    if (cells.length === 0) continue;
    const passes = cells.filter((m) => m.pass).length;
    const totalCalls = cells.reduce((s, m) => s + m.toolCalls, 0);
    const totalErr = cells.reduce((s, m) => s + m.erroredCalls, 0);
    const meanCalls = (totalCalls / cells.length).toFixed(1);
    const fumbleRate = pct(totalErr, totalCalls);
    const meanTurns = (
      cells.reduce((s, m) => s + m.turns, 0) / cells.length
    ).toFixed(1);
    const meanSec = (
      cells.reduce((s, m) => s + m.elapsedMs, 0) /
      cells.length /
      1000
    ).toFixed(0);
    console.log(
      `| ${armLabel} | ${pct(passes, cells.length)} (${passes}/${cells.length}) | ${meanCalls} | ${fumbleRate} (${totalErr}/${totalCalls}) | ${meanTurns} | ${meanSec} |`
    );
  }

  // Machine-readable dump for the report.
  writeFileSync(
    fileURLToPath(new URL("./last-run.json", import.meta.url)),
    JSON.stringify(all, null, 2)
  );
  console.log("\nWrote raw metrics to last-run.json\n");
  process.exit(0);
}

main();

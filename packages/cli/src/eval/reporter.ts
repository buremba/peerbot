import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { EvalReport, EvalResult, TrialResult } from "./types.js";

// ─── Console reporter ──────────────────────────────────────────────────

export function printReport(report: EvalReport): void {
  console.log(chalk.bold(`\nAgent: ${report.agent}`));
  console.log(chalk.dim(`Model: ${report.provider}/${report.model}`));
  console.log(chalk.dim(`Evals: ${report.evals.length} total\n`));

  for (const evalResult of report.evals) {
    printEval(evalResult);
  }

  const { passed, failed, total } = report.summary;
  const summaryColor = failed === 0 ? chalk.green : chalk.red;
  console.log(summaryColor(`\nSummary: ${passed}/${total} evals passed`));
  if (failed > 0) {
    console.log(
      chalk.red(
        `  Failed: ${report.evals
          .filter((e) => e.passRate < 1 - 0.001)
          .map((e) => e.name)
          .join(", ")}`
      )
    );
  }
  console.log();
}

function printEval(result: EvalResult): void {
  const trialCount = result.trials.length;
  const passedCount = result.trials.filter((t) => t.passed).length;

  console.log(chalk.bold(`${result.name} (${trialCount} trials)`));

  for (const trial of result.trials) {
    printTrial(trial);
  }

  const statusColor = result.passRate >= 0.8 ? chalk.green : chalk.red;
  const status = result.passRate >= 0.8 ? "PASS" : "FAIL";
  const tokenInfo = result.totalTokens.totalTokens
    ? ` tokens=${result.totalTokens.totalTokens}`
    : "";
  console.log(
    statusColor(
      `  ${status} ${passedCount}/${trialCount} avg=${result.avgScore.toFixed(2)} p50=${result.p50LatencyMs}ms${tokenInfo}`
    )
  );
  console.log();
}

function printTrial(trial: TrialResult): void {
  const icon = trial.passed ? chalk.green("✓") : chalk.red("✗");
  const latency = chalk.dim(`(${(trial.durationMs / 1000).toFixed(1)}s)`);
  console.log(
    `  ${icon} Trial ${trial.trial}: ${trial.score.toFixed(2)} ${latency}`
  );

  for (const turn of trial.turns) {
    for (const assertion of turn.assertions) {
      if (!assertion.passed) {
        console.log(
          chalk.red(`    └ ${assertion.type}: ${assertion.reason ?? "FAIL"}`)
        );
      }
    }
  }

  if (trial.rubric) {
    for (const criterion of trial.rubric.criteria) {
      const cIcon = criterion.passed ? chalk.green("✓") : chalk.red("✗");
      console.log(`    ${cIcon} ${criterion.name}`);
      if (!criterion.passed) {
        console.log(chalk.red(`      └ ${criterion.explanation}`));
      }
    }
  }

  // Show trace IDs for failed trials (for debugging in Grafana/Tempo)
  if (!trial.passed) {
    const traceIds = trial.turns.map((t) => t.traceId).filter(Boolean);
    if (traceIds.length > 0) {
      console.log(chalk.dim(`    traces: ${traceIds.join(", ")}`));
    }
  }
}

// ─── Auto-save results ─────────────────────────────────────────────────

export async function saveResult(
  evalsDir: string,
  report: EvalReport
): Promise<string> {
  const resultsDir = join(evalsDir, ".results");
  await mkdir(resultsDir, { recursive: true });

  const slug = `${report.provider}-${report.model}`.replace(
    /[^a-z0-9-]/gi,
    "-"
  );
  const ts = report.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${slug}_${ts}.json`;
  const filepath = join(resultsDir, filename);

  await writeFile(filepath, JSON.stringify(report, null, 2));
  console.log(chalk.dim(`Results saved to ${filepath}`));
  return filepath;
}

// ─── JSON file output ──────────────────────────────────────────────────

export async function writeJsonReport(
  report: EvalReport,
  outputPath: string
): Promise<void> {
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(chalk.dim(`Results written to ${outputPath}`));
}

// ─── Markdown comparison report ────────────────────────────────────────

async function loadSavedResults(evalsDir: string): Promise<EvalReport[]> {
  const resultsDir = join(evalsDir, ".results");
  try {
    const files = await readdir(resultsDir);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first

    const reports: EvalReport[] = [];
    for (const file of jsonFiles) {
      const content = await readFile(join(resultsDir, file), "utf-8");
      reports.push(JSON.parse(content) as EvalReport);
    }
    return reports;
  } catch {
    return [];
  }
}

/**
 * Group saved results by model and pick the latest run per model.
 */
function latestPerModel(reports: EvalReport[]): EvalReport[] {
  const byModel = new Map<string, EvalReport>();
  for (const report of reports) {
    const key = `${report.provider}/${report.model}`;
    const existing = byModel.get(key);
    if (!existing || report.timestamp > existing.timestamp) {
      byModel.set(key, report);
    }
  }
  return Array.from(byModel.values());
}

async function generateComparisonReport(
  evalsDir: string,
  currentReport?: EvalReport
): Promise<string> {
  const allReports = await loadSavedResults(evalsDir);
  if (currentReport) allReports.unshift(currentReport);

  const models = latestPerModel(allReports);

  if (models.length === 0) {
    return "No eval results found.";
  }

  // Collect all eval names across all models
  const evalNames = [
    ...new Set(models.flatMap((m) => m.evals.map((e) => e.name))),
  ].sort();

  let md = "# Eval Report\n\n";
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Agent: ${models[0]?.agent ?? "unknown"}\n\n`;

  // ─── Summary table ──────────────────────────────────────────────
  md += "## Model Comparison\n\n";
  md += `| Eval | ${models.map((m) => `${m.provider}/${m.model}`).join(" | ")} |\n`;
  md += `| --- | ${models.map(() => "---").join(" | ")} |\n`;

  for (const evalName of evalNames) {
    const cells = models.map((m) => {
      const evalResult = m.evals.find((e) => e.name === evalName);
      if (!evalResult) return "-";
      const icon = evalResult.passRate >= 0.8 ? "PASS" : "FAIL";
      return `${icon} ${evalResult.avgScore.toFixed(2)} (${Math.round(evalResult.passRate * 100)}%)`;
    });
    md += `| ${evalName} | ${cells.join(" | ")} |\n`;
  }

  // ─── Overall scores ──────────────────────────────────────────────
  md += "\n## Overall Scores\n\n";
  md += "| Model | Pass Rate | Avg Score | p50 Latency | Total Tokens |\n";
  md += "| --- | --- | --- | --- | --- |\n";

  for (const report of models) {
    const overallPassRate =
      report.evals.length > 0
        ? report.evals.filter((e) => e.passRate >= 0.8).length /
          report.evals.length
        : 0;
    const overallAvgScore =
      report.evals.length > 0
        ? report.evals.reduce((sum, e) => sum + e.avgScore, 0) /
          report.evals.length
        : 0;
    const overallP50 =
      report.evals.length > 0
        ? report.evals.reduce((sum, e) => sum + e.p50LatencyMs, 0) /
          report.evals.length
        : 0;
    const totalTokens = report.evals.reduce(
      (sum, e) => sum + (e.totalTokens?.totalTokens ?? 0),
      0
    );

    md += `| ${report.provider}/${report.model} | ${Math.round(overallPassRate * 100)}% | ${overallAvgScore.toFixed(2)} | ${Math.round(overallP50)}ms | ${totalTokens.toLocaleString()} |\n`;
  }

  // ─── Rubric details (latest run per model) ───────────────────────
  for (const report of models) {
    const rubricEvals = report.evals.filter((e) =>
      e.trials.some((t) => t.rubric)
    );
    if (rubricEvals.length === 0) continue;

    md += `\n## Rubric Details: ${report.provider}/${report.model}\n\n`;
    for (const evalResult of rubricEvals) {
      md += `### ${evalResult.name}\n\n`;
      // Show criteria from first trial that has rubric
      const trial = evalResult.trials.find((t) => t.rubric);
      if (!trial?.rubric) continue;

      for (const criterion of trial.rubric.criteria) {
        const icon = criterion.passed ? "PASS" : "FAIL";
        md += `- **${criterion.name}**: ${icon}`;
        if (!criterion.passed) {
          md += ` -- ${criterion.explanation}`;
        }
        md += "\n";
      }
      md += "\n";
    }
  }

  // ─── Failed trials with transcripts and trace IDs ─────────────────
  for (const report of models) {
    const failedEvals = report.evals.filter((e) =>
      e.trials.some((t) => !t.passed)
    );
    if (failedEvals.length === 0) continue;

    md += `\n## Failed Trials: ${report.provider}/${report.model}\n\n`;
    for (const evalResult of failedEvals) {
      const failedTrials = evalResult.trials.filter((t) => !t.passed);
      for (const trial of failedTrials) {
        md += `### ${evalResult.name} -- Trial ${trial.trial} (score: ${trial.score.toFixed(2)})\n\n`;

        // Trace IDs for Grafana/Tempo lookup
        const traceIds = trial.turns.map((t) => t.traceId).filter(Boolean);
        if (traceIds.length > 0) {
          md += `**Trace IDs:** ${traceIds.map((id) => `\`${id}\``).join(", ")}\n\n`;
        }

        // Failed assertions
        for (const turn of trial.turns) {
          const failed = turn.assertions.filter((a) => !a.passed);
          if (failed.length === 0) continue;
          md += `**User:** ${turn.user}\n\n`;
          md += `**Agent:** ${turn.agent.slice(0, 500)}${turn.agent.length > 500 ? "..." : ""}\n\n`;
          for (const assertion of failed) {
            md += `- **${assertion.type}**: FAIL`;
            if (assertion.reason) md += ` -- ${assertion.reason}`;
            md += "\n";
          }
          md += "\n";
        }

        // Rubric failures
        if (trial.rubric) {
          const failedCriteria = trial.rubric.criteria.filter((c) => !c.passed);
          if (failedCriteria.length > 0) {
            md += "**Rubric failures:**\n";
            for (const c of failedCriteria) {
              md += `- **${c.name}**: ${c.explanation}\n`;
            }
            md += "\n";
          }
        }
      }
    }
  }

  return md;
}

export async function writeMarkdownReport(
  evalsDir: string,
  currentReport?: EvalReport
): Promise<string> {
  const md = await generateComparisonReport(evalsDir, currentReport);
  const reportPath = join(evalsDir, "evals-report.md");
  await writeFile(reportPath, md);
  console.log(chalk.dim(`Report written to ${reportPath}`));
  return reportPath;
}

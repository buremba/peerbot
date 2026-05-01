import { printReport, runBenchmarkFromConfigPath } from '../../packages/server/src/benchmarks/memory/runner.ts';

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main() {
  const configPath = readFlag('--config') ?? 'benchmarks/memory/config.example.json';
  const { report, reportPath, markdownPath } = await runBenchmarkFromConfigPath(configPath);
  printReport(report);
  console.log(`Saved JSON report to ${reportPath}`);
  console.log(`Saved Markdown report to ${markdownPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

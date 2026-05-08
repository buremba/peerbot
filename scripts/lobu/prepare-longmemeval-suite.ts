import {
  type LongMemEvalVariant,
  prepareLongMemEvalSuite,
} from '../../packages/server/src/benchmarks/memory/public-datasets/longmemeval.ts';

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function parseOptionalInt(value: string | null, flag: string): number | undefined {
  if (value == null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

async function main() {
  const variant = (readFlag('--variant') ?? 'oracle') as LongMemEvalVariant;
  if (!['oracle', 's', 'm'].includes(variant)) {
    throw new Error(`Unsupported LongMemEval variant '${variant}'`);
  }

  const limit = parseOptionalInt(readFlag('--limit'), '--limit');
  const offset = parseOptionalInt(readFlag('--offset'), '--offset');
  const outputPath =
    readFlag('--output') ??
    `benchmarks/memory/suites/longmemeval-${variant}${limit ? `.${limit}` : ''}.json`;

  const { outputPath: writtenPath, suite } = await prepareLongMemEvalSuite({
    variant,
    limit,
    offset,
    outputPath,
    suiteId: `longmemeval-${variant}${limit ? `-${limit}` : ''}`,
  });

  console.log(`Prepared LongMemEval suite: ${suite.id}`);
  console.log(`Scenarios: ${suite.scenarios.length}`);
  console.log(`Output: ${writtenPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

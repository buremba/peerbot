import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkRunConfig, CommandSystemConfig, OwlettoMcpSystemConfig } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function resolveEnvValue(value: string): string {
  if (!value.startsWith('$')) return value;
  const envName = value.slice(1);
  const resolved = process.env[envName];
  if (!resolved) {
    throw new Error(`Missing environment variable '${envName}' referenced from benchmark config`);
  }
  return resolved;
}

function validateOwlettoConfig(config: OwlettoMcpSystemConfig): OwlettoMcpSystemConfig {
  assert(config.mcpUrl, `System '${config.id}' is missing mcpUrl`);
  return config;
}

function validateCommandConfig(config: CommandSystemConfig): CommandSystemConfig {
  assert(
    Array.isArray(config.argv) && config.argv.length > 0,
    `System '${config.id}' must define argv`
  );
  return {
    ...config,
    env: Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [key, resolveEnvValue(value)])
    ),
  };
}

export function loadBenchmarkConfig(path: string): BenchmarkRunConfig {
  const absolutePath = resolve(process.cwd(), path);
  const raw = readFileSync(absolutePath, 'utf-8');
  const config = JSON.parse(raw) as BenchmarkRunConfig;

  assert(
    typeof config.suitePath === 'string' && config.suitePath.length > 0,
    'suitePath is required'
  );
  assert(
    Array.isArray(config.systems) && config.systems.length > 0,
    'At least one system is required'
  );

  const systems = config.systems
    .filter((system) => system.enabled !== false)
    .map((system) => {
      if (system.type === 'owletto-mcp') return validateOwlettoConfig(system);
      if (system.type === 'owletto-inprocess') return system;
      if (system.type === 'command') return validateCommandConfig(system);
      throw new Error(
        `Unsupported benchmark system type '${(system as { type?: string }).type ?? 'unknown'}'`
      );
    });

  return {
    ...config,
    suitePath: resolve(process.cwd(), config.suitePath),
    outputDir: resolve(process.cwd(), config.outputDir ?? '.owletto/benchmarks/memory'),
    trials: Math.max(config.trials ?? 1, 1),
    topK: Math.max(config.topK ?? 8, 1),
    systems,
  };
}

/**
 * Environment Utilities
 */

import type { Env } from '../index';

/**
 * Create Env object from process.env.
 * Since Env has an index signature, process.env satisfies it directly.
 */
export function getEnvFromProcess(): Env {
  return { ...process.env } as Env;
}

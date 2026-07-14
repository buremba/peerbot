import { checkMemoryHealth, type HealthOptions } from "./_lib/memory-health.js";

export async function memoryHealthCommand(
  options: HealthOptions
): Promise<void> {
  await checkMemoryHealth(options);
}

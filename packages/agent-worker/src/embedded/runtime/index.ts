/**
 * Worker-side runtime-provider registration barrel. Importing this module
 * registers every built-in provider as a side effect; adding a provider is one
 * new file under `providers/` + one `registerWorkerRuntimeProvider` call here.
 */
import { vercelWorkerRuntimeProvider } from "./providers/vercel";
import { registerWorkerRuntimeProvider } from "./registry";

registerWorkerRuntimeProvider(vercelWorkerRuntimeProvider);

export { getWorkerRuntimeProvider } from "./registry";
export type { WorkerRuntimeProvider } from "./types";

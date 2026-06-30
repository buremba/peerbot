/**
 * Gateway-side runtime-provider registration barrel. Importing this registers
 * every built-in provider as a side effect; adding a provider is one new file
 * under `providers/` + one `registerGatewayRuntimeProvider` call here.
 */
import { vercelGatewayRuntimeProvider } from "./providers/vercel.js";
import { registerGatewayRuntimeProvider } from "./registry.js";

registerGatewayRuntimeProvider(vercelGatewayRuntimeProvider);

export {
  getGatewayRuntimeProvider,
  listGatewayRuntimeProviderIds,
} from "./registry.js";
export type {
  GatewayRuntimeProvider,
  RuntimeExecContext,
  RuntimeExecResult,
} from "./types.js";

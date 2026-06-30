import { createGenericRuntimeBashOps } from "../generic-runtime-bash";
import type { WorkerRuntimeProvider } from "../types";

/**
 * Vercel persistent-sandbox runtime (worker side). The sandbox filesystem is
 * rooted at `/vercel/sandbox`; HOME/TMP/cache must point inside it so tools
 * don't write to the read-only image.
 */
export const vercelWorkerRuntimeProvider: WorkerRuntimeProvider = {
  id: "vercel",
  remoteEnv: {
    HOME: "/vercel/sandbox",
    TMPDIR: "/vercel/sandbox/.tmp",
    TMP: "/vercel/sandbox/.tmp",
    TEMP: "/vercel/sandbox/.tmp",
    XDG_CACHE_HOME: "/vercel/sandbox/.cache",
  },
  createBashOps(params) {
    return createGenericRuntimeBashOps(this, params);
  },
};

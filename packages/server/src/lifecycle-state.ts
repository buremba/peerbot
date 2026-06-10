/**
 * Process-wide shutdown signal, shared between the lifecycle teardown
 * (server-lifecycle.ts) and the readiness probe (index.ts).
 *
 * On SIGTERM we flip this flag FIRST, before any teardown runs. The readiness
 * probe (`/health/ready`) then returns 503, which makes kube-proxy drop the pod
 * from the Service endpoint set within one probe period — so the load balancer
 * stops routing new requests to a pod that is about to stop serving. Without
 * this, endpoint removal lags teardown and clients hit connection-refused on
 * every rolling deploy.
 *
 * This is intentionally a tiny module-level boolean: it is read/written only
 * within a single process, so there is no multi-replica concern (each pod owns
 * its own shutdown lifecycle).
 */
let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

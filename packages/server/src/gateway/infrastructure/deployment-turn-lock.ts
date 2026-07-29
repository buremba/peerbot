import { getLockDb, type DbClient } from "../../db/client.js";

const DEPLOYMENT_TURN_LOCK_NAMESPACE = "lobu:deployment-turn";

/**
 * Serialize a turn marker with deployment teardown in the transaction that
 * persists the marker. A teardown either sees the marker and defers, or
 * finishes before the marker transaction continues.
 */
export async function lockDeploymentTurnInTransaction(
  sql: DbClient,
  deploymentName: string
): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${DEPLOYMENT_TURN_LOCK_NAMESPACE}),
      hashtext(${deploymentName})
    )
  `;
}

/**
 * Hold the deployment-turn lock across a teardown whose liveness read and
 * process exit span multiple database transactions.
 */
export async function withDeploymentTurnLock<T>(
  deploymentName: string,
  action: () => Promise<T>
): Promise<T> {
  const reserved = await getLockDb().reserve();
  let acquired = false;
  try {
    await reserved`SELECT set_config('lock_timeout', '30s', false)`;
    await reserved`
      SELECT pg_advisory_lock(
        hashtext(${DEPLOYMENT_TURN_LOCK_NAMESPACE}),
        hashtext(${deploymentName})
      )
    `;
    acquired = true;
    return await action();
  } finally {
    try {
      if (acquired) {
        await reserved`
          SELECT pg_advisory_unlock(
            hashtext(${DEPLOYMENT_TURN_LOCK_NAMESPACE}),
            hashtext(${deploymentName})
          )
        `;
      }
    } finally {
      reserved.release();
    }
  }
}

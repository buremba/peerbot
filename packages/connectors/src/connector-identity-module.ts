/**
 * Connector-owned identity module contract.
 *
 * Each connector that mints identity namespaces exports one of these. It is the
 * connector's self-description of the identity vocabulary it owns: how to
 * normalize its namespaces, and which of them are backed by an event-recall
 * index. The server assembles every module into the ingest normalizer chain and
 * the recall-namespace set (see
 * server/src/identity/connector-identity-modules.ts) — core code never names a
 * specific connector.
 *
 * Adding a connector namespace is: define the constants + normalizer here,
 * list recall namespaces, and (if recall-indexed) ship the matching
 * `idx_events_metadata_<ns>` migration. A startup + CI invariant asserts the
 * recall-namespace set matches the physical indexes.
 */
export interface ConnectorIdentityModule {
  /** Connector/platform key (`slack`, `github`, `x`, …). */
  key: string;
  /**
   * Namespaces this connector owns that participate in read-time event recall.
   * Each MUST have a physical `idx_events_metadata_<ns>` partial index, or
   * recall seq-scans the events table. Enforced by a startup/CI invariant.
   */
  recallNamespaces: string[];
  /**
   * Normalize a value for one of this connector's namespaces. Returns
   * `undefined` when the namespace is not owned by this connector (the caller
   * chains to the next module, then to generic SDK hygiene). `null` means the
   * namespace IS owned but the value is invalid.
   */
  normalize(namespace: string, raw: string): string | null | undefined;
}

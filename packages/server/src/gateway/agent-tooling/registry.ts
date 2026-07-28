/**
 * Process-wide (per-pod) {@link CredentialLeaseRegistry} singleton + the default
 * provider wiring.
 *
 * Per-pod like the installation-token registry it delegates to: leases are
 * minted statelessly per deployment and nothing is shared across replicas.
 */

import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
  CredentialLeaseRegistry,
  GitHubCredentialLeaseProvider,
} from "./credential-lease.js";

let registry: CredentialLeaseRegistry | null = null;

/** The per-pod registry, built lazily with the default providers registered. */
export function getCredentialLeaseRegistry(): CredentialLeaseRegistry {
  if (!registry) {
    registry = new CredentialLeaseRegistry();
    registry.register(
      new GitHubCredentialLeaseProvider(createPostgresAppInstallationStore())
    );
  }
  return registry;
}

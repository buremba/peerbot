import { createHash } from "node:crypto";
import { createLogger } from "@lobu/core";
import { nixPackageAttrRef } from "@lobu/connector-sdk/nix-package";

/**
 * Generic, provider-agnostic handling of the signed `nixPackages` claim.
 *
 * Portability is the point: the same `["gh"]` declaration must mean the same
 * thing on every backend, so nix — already the vocabulary in
 * `SkillConfig.nixPackages` and `ConnectorDefinition.runtime.nix` — is the one
 * package language, not the base image's apt/apk/yum.
 */

const logger = createLogger("runtime-packages");

/**
 * Filter a signed package claim down to names that are safe on a command line.
 *
 * Every entry ends up as an argument to `nix profile install nixpkgs#<name>`
 * inside the sandbox, so it goes through the SAME validator the local
 * `nix-shell` spawn and the connector-worker executor use. An invalid name is
 * dropped, not escaped and not passed through: the claim is minted from
 * operator/connector-declared data, so a name that fails here is a bug or an
 * attack, and in both cases contributing nothing is the correct outcome.
 *
 * Deduplicated and sorted so the derived marker hash is stable regardless of
 * declaration order across connections.
 */
export function sanitizeNixPackages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const safe = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    try {
      nixPackageAttrRef(entry);
      safe.add(entry);
    } catch {
      logger.warn(
        { package: entry },
        "Dropping invalid nix package name from the runtime provisioning claim"
      );
    }
  }
  return [...safe].sort();
}

/**
 * Stable identity of a package SET. The sandbox stores this next to its
 * provisioned profile; a match means the exact same set is already installed
 * and provisioning can be skipped.
 *
 * The state lives in the sandbox filesystem rather than a gateway Map on
 * purpose: N replicas serve a conversation's messages, and the replica that
 * provisioned is not the one that handles the next turn.
 */
export function nixPackageSetHash(packages: string[]): string {
  return createHash("sha256")
    .update(sanitizeNixPackages(packages).join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Binary-cache / channel hosts a nix install must reach. Same list the local
 * embedded path grants (`NIX_CACHE_DOMAINS` in the deployment manager) — a
 * remote sandbox is deny-by-default too, so provisioning hangs without them.
 */
export const NIX_SUBSTITUTER_DOMAINS = [
  "cache.nixos.org",
  "channels.nixos.org",
  "releases.nixos.org",
];

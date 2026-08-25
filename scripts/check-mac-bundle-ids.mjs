#!/usr/bin/env node
/**
 * Mac bundle-identity gate.
 *
 * `PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj` is the real bundle id:
 * `CFBundleIdentifier` in Info.plist resolves to `$(PRODUCT_BUNDLE_IDENTIFIER)`
 * at build time. The URL scheme, the Keychain service name, and the Sparkle
 * update path are all keyed off it, so the Release identity is part of the
 * upgrade contract for every installed app — change it and existing installs
 * stop updating and lose their stored secrets.
 *
 * The identity is pinned PER BUILD CONFIGURATION rather than globally:
 *
 *   Release  must be exactly `com.owletto.mac`.
 *   Debug    may be `com.owletto.mac` or the build-scoped
 *            `com.owletto.mac.debug`, so a developer build installs and stores
 *            credentials beside the Release app instead of colliding with it.
 *
 * Why per-configuration and not "the set of distinct values must be
 * {com.owletto.mac, com.owletto.mac.debug}": a set cannot tell
 * `Release=mac, Debug=mac.debug` apart from the swapped
 * `Release=mac.debug, Debug=mac`, and the swapped form ships a release DMG
 * under the debug identity — precisely the break this gate exists to stop.
 *
 * Degenerate shapes fail closed rather than passing vacuously: a pbxproj the
 * parser finds no identity in (the setting moved or was renamed), and one with
 * no Release configuration at all, are each an error.
 */

import { readFileSync } from "node:fs";

const EXPECTED_RELEASE_BUNDLE_ID = "com.owletto.mac";
const EXPECTED_DEBUG_BUNDLE_ID = "com.owletto.mac.debug";
const DEFAULT_PBXPROJ =
  "packages/owletto/apps/mac/Owletto.xcodeproj/project.pbxproj";

/**
 * Pair each XCBuildConfiguration block's `PRODUCT_BUNDLE_IDENTIFIER` with the
 * block's own `name`. pbxproj emits `buildSettings` before the closing
 * `name = <config>;`, so the identity is always in hand by the time the name
 * is read; `isa = XCBuildConfiguration` resets it so a block that sets no
 * identity cannot inherit the previous block's.
 */
export function parseBundleIdsByConfiguration(source) {
  const found = [];
  let bundleId = null;
  for (const line of source.split("\n")) {
    if (line.includes("isa = XCBuildConfiguration;")) {
      bundleId = null;
      continue;
    }
    const setting = line.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/);
    if (setting) {
      bundleId = setting[1].trim().replace(/^"|"$/g, "");
      continue;
    }
    const name = line.match(/^\s*name = ([^;]+);/);
    if (name && bundleId !== null) {
      found.push({
        configuration: name[1].trim().replace(/^"|"$/g, ""),
        bundleId,
      });
      bundleId = null;
    }
  }
  return found;
}

/** Returns the list of violations; empty means the pbxproj satisfies the contract. */
export function checkBundleIds(source) {
  const found = parseBundleIdsByConfiguration(source);
  if (found.length === 0) {
    return [
      "no PRODUCT_BUNDLE_IDENTIFIER found per build configuration — the bundle id gate is not actually checking anything (setting moved or renamed?)",
    ];
  }
  if (!found.some((entry) => entry.configuration === "Release")) {
    const seen = found.map((e) => `${e.configuration}=${e.bundleId}`).join(" ");
    return [
      `no Release build configuration sets PRODUCT_BUNDLE_IDENTIFIER (got: ${seen})`,
    ];
  }

  const problems = [];
  for (const { configuration, bundleId } of found) {
    if (configuration === "Release") {
      if (bundleId !== EXPECTED_RELEASE_BUNDLE_ID) {
        problems.push(
          `Release PRODUCT_BUNDLE_IDENTIFIER is '${bundleId}', expected '${EXPECTED_RELEASE_BUNDLE_ID}'. Bundle id drift breaks installed-app upgrades.`
        );
      }
    } else if (configuration === "Debug") {
      if (
        bundleId !== EXPECTED_RELEASE_BUNDLE_ID &&
        bundleId !== EXPECTED_DEBUG_BUNDLE_ID
      ) {
        problems.push(
          `Debug PRODUCT_BUNDLE_IDENTIFIER is '${bundleId}', expected '${EXPECTED_RELEASE_BUNDLE_ID}' or '${EXPECTED_DEBUG_BUNDLE_ID}'.`
        );
      }
    } else {
      problems.push(
        `unexpected build configuration '${configuration}' sets PRODUCT_BUNDLE_IDENTIFIER='${bundleId}'; only Debug and Release are known.`
      );
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? DEFAULT_PBXPROJ;
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`::error::cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
  const problems = checkBundleIds(source);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `bundle id gate: ${path} pins Release to ${EXPECTED_RELEASE_BUNDLE_ID}`
  );
}

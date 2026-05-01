/**
 * Side-effect imports for every connector that should be available to the
 * identity engine. Each imported module self-registers via
 * `registerConnector(...)` at load time.
 *
 * Adding a new connector: drop a file in this directory, end it with
 * `registerConnector(...)`, and add a side-effect import here.
 *
 * The post-import assertion below catches the case where a future tree-shake
 * or refactor drops one of these imports — registry stays empty, the engine
 * silently does nothing. Failing here at module load surfaces the wiring bug
 * before any sign-in handler runs.
 */

import { connectorCapabilityRegistry } from "../capability-registry";
import "./google";

if (connectorCapabilityRegistry.size() === 0) {
	throw new Error(
		"identity/connectors/index.ts loaded without registering any connector — check side-effect imports",
	);
}

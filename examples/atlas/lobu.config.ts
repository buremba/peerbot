import { defineConfig } from "@lobu/cli/config";

export default defineConfig({
  // Atlas also contains device- and platform-managed definitions that this
  // project must preserve. Legacy resources are decommissioned explicitly.
  prune: false,
  org: "atlas",
  agents: [],
});

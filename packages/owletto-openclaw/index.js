// Compatibility redirect: this package was renamed to @lobu/openclaw-plugin.
// Re-export the default plugin object plus any named exports so OpenClaw
// runtime (which loads via openclaw.plugin.json's `entry` field) keeps working.
export { default } from "@lobu/openclaw-plugin";
export * from "@lobu/openclaw-plugin";

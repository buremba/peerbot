import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: [
    "@kubernetes/client-node",
    "@slack/bolt", 
    "@slack/web-api",
    "@octokit/rest",
    "@google-cloud/storage",
    "@claude-code-slack/core-runner"
  ]
});

console.log("Build complete\!");
EOF < /dev/null
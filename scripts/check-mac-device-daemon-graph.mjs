#!/usr/bin/env node

import { readFileSync } from "node:fs";

const FORBIDDEN_GRAPH_PATTERNS = [
  /packages\/connector-worker\/src\/(?:compile(?:-connector)?|embeddings(?:[-/]|\.))/,
  /packages\/embeddings\//,
  /packages\/connector-worker\/src\/executor\/(?!redact(?:\.ts|\.js)?$)/,
  /packages\/connector-worker\/src\/self-check\//,
  /node_modules\/(?:@lobu\/embeddings|@xenova\/transformers|onnxruntime(?:-[^/]+)?|playwright|patchright|sharp|jimp)(?:\/|$)/,
];

export function forbiddenMacDeviceDaemonGraphInputs(inputs) {
  return Object.keys(inputs).filter((input) =>
    FORBIDDEN_GRAPH_PATTERNS.some((pattern) => pattern.test(input))
  );
}

export function assertMacDeviceDaemonGraph(inputs) {
  const forbidden = forbiddenMacDeviceDaemonGraphInputs(inputs);
  if (forbidden.length > 0) {
    throw new Error(
      `lean Mac device-daemon graph contains forbidden fleet/runtime modules:\n${forbidden
        .map((input) => `- ${input}`)
        .join("\n")}`
    );
  }
  return inputs;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const metafile = process.argv[2];
  if (!metafile)
    throw new Error("usage: check-mac-device-daemon-graph.mjs <metafile.json>");
  const graph = JSON.parse(readFileSync(metafile, "utf8"));
  assertMacDeviceDaemonGraph(graph.inputs ?? {});
  console.log(
    `Mac device-daemon graph clean (${Object.keys(graph.inputs ?? {}).length} modules)`
  );
}

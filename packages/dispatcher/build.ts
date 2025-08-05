#!/usr/bin/env bun

import { build } from "bun";
import { readdir } from "fs/promises";
import { join } from "path";

// Recursively find all TypeScript files
async function findTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") {
      files.push(...await findTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function main() {
  try {
    // Find all TypeScript files in src
    const files = await findTypeScriptFiles('./src');
    
    console.log(`Building ${files.length} TypeScript files...`);
    
    // Build all files
    const result = await build({
      entrypoints: files,
      outdir: './dist',
      target: 'node',
      format: 'esm',
      splitting: false,
      sourcemap: 'external',
      minify: false,
      // Preserve the directory structure
      naming: {
        entry: '[dir]/[name].[ext]',
      },
    });
    
    if (result.success) {
      console.log('Build complete!');
    } else {
      console.error('Build failed:', result.logs);
      process.exit(1);
    }
  } catch (error) {
    console.error('Build error:', error);
    process.exit(1);
  }
}

main();
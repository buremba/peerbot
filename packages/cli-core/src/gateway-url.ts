import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const GATEWAY_DEFAULT_URL = "http://localhost:8080";

export interface ResolveGatewayUrlOptions {
  cwd?: string;
}

/**
 * Resolve the local gateway URL by reading `GATEWAY_PORT` from the project's
 * `.env` file (if present). Falls back to `GATEWAY_DEFAULT_URL` when the file
 * is missing or the variable is not set.
 */
export async function resolveGatewayUrl(
  options: ResolveGatewayUrlOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("GATEWAY_PORT=")) {
        let port = trimmed.slice("GATEWAY_PORT=".length);
        if (
          (port.startsWith('"') && port.endsWith('"')) ||
          (port.startsWith("'") && port.endsWith("'"))
        ) {
          port = port.slice(1, -1);
        }
        if (port) return `http://localhost:${port}`;
      }
    }
  } catch {
    // No .env file
  }
  return GATEWAY_DEFAULT_URL;
}

#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ArtifactStore } from "../../files/artifact-store.js";

const logger = createLogger("public-files");

export function createPublicFileRoutes(artifactStore: ArtifactStore): Hono {
  const router = new Hono();

  router.get("/api/v1/files/:artifactId", async (c) => {
    const artifactId = c.req.param("artifactId");
    const token = c.req.query("token");

    if (!artifactId || !token) {
      return c.json(
        { success: false, error: "Missing artifactId or token" },
        400
      );
    }

    const validation = artifactStore.validateDownloadToken(token, artifactId);
    if (!validation.valid) {
      return c.json(
        {
          success: false,
          error: `Invalid file token: ${validation.error || "unknown"}`,
        },
        401
      );
    }

    const artifact = await artifactStore.read(artifactId);
    if (!artifact) {
      return c.json({ success: false, error: "File not found" }, 404);
    }

    logger.info(
      `Serving artifact ${artifactId} (${artifact.metadata.filename})`
    );

    c.header("Content-Type", artifact.metadata.contentType);
    c.header("Content-Length", artifact.metadata.size.toString());
    // `filename` is operator-/worker-supplied and survives only
    // `path.basename()` in the store, so it may still contain quotes,
    // backslashes, CR/LF, or non-ASCII. Quote it as a quoted-string per
    // RFC 6266 + emit a UTF-8 `filename*` so non-ASCII names render correctly
    // without letting a `"` break out and inject another header.
    const rawName = artifact.metadata.filename;
    const fallbackName = rawName.replace(/[\r\n\\"]+/g, "_") || "download";
    const utf8Name = encodeURIComponent(rawName).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
    );
    c.header(
      "Content-Disposition",
      `attachment; filename="${fallbackName}"; filename*=UTF-8''${utf8Name}`
    );
    c.header("Cache-Control", "private, max-age=60");

    return new Response(await readFile(artifact.filePath), {
      headers: c.res.headers,
    });
  });

  return router;
}

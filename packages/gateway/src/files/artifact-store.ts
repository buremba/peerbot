import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger, decrypt, encrypt } from "@lobu/core";

const logger = createLogger("artifact-store");
const DEFAULT_ARTIFACTS_DIR = path.join(os.tmpdir(), "lobu-artifacts");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredArtifactMetadata {
  artifactId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
}

interface PublishArtifactResult {
  artifactId: string;
  filename: string;
  size: number;
  contentType: string;
  downloadUrl: string;
}

function sanitizeFilename(filename: string): string {
  const safe = path.basename(filename).trim();
  return safe || "download";
}

function normalizeBaseUrl(publicGatewayUrl: string): string {
  const trimmed = publicGatewayUrl.trim();
  if (!trimmed) {
    return "http://localhost:8080";
  }
  return trimmed.replace(/\/$/, "");
}

export class ArtifactStore {
  constructor(
    private readonly baseDir = process.env.LOBU_ARTIFACTS_DIR ||
      DEFAULT_ARTIFACTS_DIR,
    private readonly defaultTtlMs = DEFAULT_TTL_MS
  ) {}

  private artifactDir(artifactId: string): string {
    return path.join(this.baseDir, artifactId);
  }

  private artifactFilePath(artifactId: string, filename: string): string {
    return path.join(this.artifactDir(artifactId), sanitizeFilename(filename));
  }

  private metadataPath(artifactId: string): string {
    return path.join(this.artifactDir(artifactId), "metadata.json");
  }

  async publish(params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    publicGatewayUrl: string;
    ttlMs?: number;
  }): Promise<PublishArtifactResult> {
    const artifactId = randomUUID();
    const filename = sanitizeFilename(params.filename);
    const contentType = params.contentType || "application/octet-stream";
    const createdAt = Date.now();
    const dir = this.artifactDir(artifactId);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.artifactFilePath(artifactId, filename),
      params.buffer
    );
    await fs.writeFile(
      this.metadataPath(artifactId),
      JSON.stringify(
        {
          artifactId,
          filename,
          contentType,
          size: params.buffer.length,
          createdAt,
        } satisfies StoredArtifactMetadata,
        null,
        2
      )
    );

    logger.info(
      `Published artifact ${artifactId} (${filename}, ${params.buffer.length} bytes)`
    );

    return {
      artifactId,
      filename,
      size: params.buffer.length,
      contentType,
      downloadUrl: this.buildDownloadUrl(
        normalizeBaseUrl(params.publicGatewayUrl),
        artifactId,
        params.ttlMs
      ),
    };
  }

  async read(artifactId: string): Promise<{
    metadata: StoredArtifactMetadata;
    filePath: string;
  } | null> {
    try {
      const raw = await fs.readFile(this.metadataPath(artifactId), "utf8");
      const metadata = JSON.parse(raw) as StoredArtifactMetadata;
      const filePath = this.artifactFilePath(artifactId, metadata.filename);
      await fs.access(filePath);
      return { metadata, filePath };
    } catch {
      return null;
    }
  }

  createDownloadToken(artifactId: string, ttlMs = this.defaultTtlMs): string {
    return encrypt(
      JSON.stringify({
        artifactId,
        exp: Date.now() + ttlMs,
      })
    );
  }

  validateDownloadToken(
    token: string,
    artifactId: string
  ): {
    valid: boolean;
    error?: string;
  } {
    try {
      const payload = JSON.parse(decrypt(token)) as {
        artifactId?: string;
        exp?: number;
      };
      if (payload.artifactId !== artifactId) {
        return { valid: false, error: "artifact_mismatch" };
      }
      if (!payload.exp || Date.now() > payload.exp) {
        return { valid: false, error: "expired" };
      }
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  buildDownloadUrl(
    publicGatewayUrl: string,
    artifactId: string,
    ttlMs = this.defaultTtlMs
  ): string {
    const baseUrl = normalizeBaseUrl(publicGatewayUrl);
    const url = new URL(
      `/api/v1/files/${encodeURIComponent(artifactId)}`,
      baseUrl
    );
    url.searchParams.set("token", this.createDownloadToken(artifactId, ttlMs));
    return url.toString();
  }

  createReadStream(artifactId: string, filename: string) {
    return createReadStream(this.artifactFilePath(artifactId, filename));
  }
}

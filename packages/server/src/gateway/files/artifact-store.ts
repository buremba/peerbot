import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decrypt, encrypt, getErrorMessage } from "@lobu/core";
import logger from "../../utils/logger";

const DEFAULT_ARTIFACTS_DIR = path.join(os.tmpdir(), "lobu-artifacts");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_PAYLOAD_FILENAME = "content";
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
const DEFAULT_ARTIFACT_READ_MAX_BYTES = 50 * 1024 * 1024;
const ARTIFACT_TRASH_DIRNAME = ".trash";
const DOWNLOAD_TOKEN_MAX_CHARS = 4096;

interface StoredArtifactMetadata {
  artifactId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  sha256: string;
  /** Immutable Lobu resource identity allowed to read this artifact internally. */
  binding?: string;
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

export function runArtifactBinding(runId: number): string {
  return `run:${runId}`;
}

export function eventArtifactBinding(params: {
  organizationId: string;
  connectionId?: number | null;
  feedId?: number | null;
  originId: string;
}): string {
  const sourceScope =
    params.connectionId != null
      ? `connection:${params.connectionId}`
      : params.feedId != null
        ? `feed:${params.feedId}`
        : "unscoped";
  return `event:${params.organizationId}:${sourceScope}:${params.originId}`;
}

function normalizeBaseUrl(publicGatewayUrl: string): string {
  const trimmed = publicGatewayUrl.trim();
  if (!trimmed) {
    return "http://localhost:8080";
  }
  return trimmed.replace(/\/$/, "");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isStoredArtifactMetadata(
  value: unknown,
  artifactId: string,
): value is StoredArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.artifactId === artifactId &&
    typeof metadata.filename === "string" &&
    metadata.filename.length > 0 &&
    metadata.filename.length <= 1024 &&
    typeof metadata.contentType === "string" &&
    metadata.contentType.length > 0 &&
    metadata.contentType.length <= 512 &&
    typeof metadata.size === "number" &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    typeof metadata.createdAt === "number" &&
    Number.isFinite(metadata.createdAt) &&
    typeof metadata.sha256 === "string" &&
    ARTIFACT_SHA256_PATTERN.test(metadata.sha256) &&
    (metadata.binding === undefined ||
      (typeof metadata.binding === "string" && metadata.binding.length <= 2048))
  );
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function resolveArtifactsDir(baseDir: string | undefined): string {
  const configured = baseDir?.trim() || process.env.LOBU_ARTIFACTS_DIR?.trim();
  if (configured) return configured;
  if (process.env.ENVIRONMENT === "production") {
    throw new Error(
      "Production artifact storage requires LOBU_ARTIFACTS_DIR on a durable shared filesystem",
    );
  }
  return DEFAULT_ARTIFACTS_DIR;
}

export class ArtifactStore {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly defaultTtlMs = DEFAULT_TTL_MS,
  ) {
    this.baseDir = resolveArtifactsDir(baseDir);
  }

  private artifactDir(artifactId: string): string {
    return path.join(this.baseDir, artifactId);
  }

  private artifactFilePath(artifactId: string): string {
    return path.join(this.artifactDir(artifactId), ARTIFACT_PAYLOAD_FILENAME);
  }

  private metadataPath(artifactId: string): string {
    return path.join(this.artifactDir(artifactId), "metadata.json");
  }

  /**
   * Inside `baseDir` so the quarantine rename stays on one filesystem — the
   * configured directory is the PVC mount root, and a sibling would land on
   * the pod's ephemeral layer and fail with EXDEV. The name cannot collide
   * with an artifact directory because those are always UUIDs.
   */
  private trashDir(): string {
    return path.join(this.baseDir, ARTIFACT_TRASH_DIRNAME);
  }

  private async drainTrash(): Promise<void> {
    const trashDir = this.trashDir();
    await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
    for (const stale of await fs.readdir(trashDir)) {
      const stalePath = path.join(trashDir, stale);
      try {
        await fs.rm(stalePath, { recursive: true, force: true });
      } catch (error) {
        // Server logger errors are forwarded to Sentry. A retained orphan
        // blocks later publication by design, so make that operationally loud
        // while preserving the fail-closed behavior.
        logger.error(
          { err: error, stalePath },
          "Artifact trash drain failed; publication is blocked",
        );
        throw error;
      }
    }
  }

  /**
   * Delete by rename-then-remove so a concurrent reader either sees the whole
   * artifact or nothing — never a directory losing its files underneath it.
   * The quarantined copy is removed immediately; one only lingers when that
   * removal fails. Every later publish drains earlier leftovers first and
   * fails closed if that is still impossible; the retained PVC has no other
   * process that can safely infer which directories are uncommitted.
   */
  private async quarantineAndDelete(artifactId: string): Promise<void> {
    const trashDir = this.trashDir();
    await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
    const source = this.artifactDir(artifactId);
    const quarantined = path.join(trashDir, `${artifactId}-${randomUUID()}`);
    try {
      await fs.rename(source, quarantined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.drainTrash();
        return;
      }
      throw error;
    }
    await this.drainTrash();
  }

  async publish(params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    publicGatewayUrl: string;
    ttlMs?: number;
    binding?: string;
  }): Promise<PublishArtifactResult> {
    const artifactId = randomUUID();
    const filename = sanitizeFilename(params.filename);
    const contentType = params.contentType || "application/octet-stream";
    const createdAt = Date.now();
    const checksum = sha256(params.buffer);
    const metadata: StoredArtifactMetadata = {
      artifactId,
      filename,
      contentType,
      size: params.buffer.length,
      createdAt,
      sha256: checksum,
      ...(params.binding ? { binding: params.binding } : {}),
    };

    const dir = this.artifactDir(artifactId);
    try {
      await this.drainTrash();
      // Exclusive: a collision on a freshly minted UUID means the directory is
      // not ours, so never adopt it.
      await fs.mkdir(dir, { recursive: false, mode: 0o700 });
      await fs.writeFile(this.artifactFilePath(artifactId), params.buffer, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.writeFile(
        this.metadataPath(artifactId),
        JSON.stringify(metadata, null, 2),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      try {
        await this.quarantineAndDelete(artifactId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Artifact publication failed and its partial directory could not be quarantined: ${getErrorMessage(cleanupError)}`,
        );
      }
      throw error;
    }

    logger.info(
      `Published artifact ${artifactId} (${filename}, ${params.buffer.length} bytes)`,
    );

    return {
      artifactId,
      filename,
      size: params.buffer.length,
      contentType,
      downloadUrl: this.buildDownloadUrl(
        normalizeBaseUrl(params.publicGatewayUrl),
        artifactId,
        params.ttlMs,
      ),
    };
  }

  async read(
    artifactId: string,
    options?: { binding?: string; maxBytes?: number },
  ): Promise<{ metadata: StoredArtifactMetadata; bytes: Buffer } | null> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return null;
    try {
      const dirStat = await fs.lstat(this.artifactDir(artifactId));
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
      const raw = await readBoundedRegularFile(
        this.metadataPath(artifactId),
        ARTIFACT_METADATA_MAX_BYTES,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isStoredArtifactMetadata(parsed, artifactId)) return null;
      const metadata = parsed;
      if (options?.binding && metadata.binding !== options.binding) {
        return null;
      }
      const maxBytes = options?.maxBytes ?? DEFAULT_ARTIFACT_READ_MAX_BYTES;
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        metadata.size > maxBytes
      ) {
        return null;
      }
      const bytes = await readBoundedRegularFile(
        this.artifactFilePath(artifactId),
        maxBytes,
      );
      if (
        !bytes ||
        bytes.length !== metadata.size ||
        sha256(bytes) !== metadata.sha256
      ) {
        logger.warn(`Artifact ${artifactId} failed size/checksum verification`);
        return null;
      }
      const finalDirStat = await fs.lstat(this.artifactDir(artifactId));
      if (
        !finalDirStat.isDirectory() ||
        finalDirStat.isSymbolicLink() ||
        finalDirStat.dev !== dirStat.dev ||
        finalDirStat.ino !== dirStat.ino
      ) {
        return null;
      }
      return { metadata, bytes };
    } catch {
      return null;
    }
  }

  /**
   * Mint a fresh public URL only when the persisted artifact still belongs to
   * the exact Lobu resource being returned. This is the read-boundary refresh
   * for expiring URLs; verifying the immutable binding prevents a caller from
   * grafting another workspace's artifact id into a readable event.
   */
  async mintBoundDownloadUrl(params: {
    artifactId: string;
    binding: string;
    publicGatewayUrl: string;
    ttlMs?: number;
  }): Promise<string | null> {
    if (!ARTIFACT_ID_PATTERN.test(params.artifactId)) return null;
    try {
      const dirStat = await fs.lstat(this.artifactDir(params.artifactId));
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
      const raw = await readBoundedRegularFile(
        this.metadataPath(params.artifactId),
        ARTIFACT_METADATA_MAX_BYTES,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (
        !isStoredArtifactMetadata(parsed, params.artifactId) ||
        parsed.binding !== params.binding
      ) {
        return null;
      }
      const finalDirStat = await fs.lstat(this.artifactDir(params.artifactId));
      if (
        !finalDirStat.isDirectory() ||
        finalDirStat.isSymbolicLink() ||
        finalDirStat.dev !== dirStat.dev ||
        finalDirStat.ino !== dirStat.ino
      ) {
        return null;
      }
      return this.buildDownloadUrl(
        params.publicGatewayUrl,
        params.artifactId,
        params.ttlMs,
      );
    } catch {
      return null;
    }
  }

  async delete(artifactId: string): Promise<void> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return;
    await this.quarantineAndDelete(artifactId);
    logger.info(`Deleted artifact ${artifactId}`);
  }

  createDownloadToken(artifactId: string, ttlMs = this.defaultTtlMs): string {
    return encrypt(
      JSON.stringify({
        artifactId,
        exp: Date.now() + ttlMs,
      }),
    );
  }

  validateDownloadToken(
    token: string,
    artifactId: string,
  ): {
    valid: boolean;
    error?: string;
  } {
    if (
      token.length === 0 ||
      token.length > DOWNLOAD_TOKEN_MAX_CHARS ||
      !ARTIFACT_ID_PATTERN.test(artifactId)
    ) {
      return { valid: false, error: "malformed" };
    }
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
    } catch {
      return { valid: false, error: "malformed" };
    }
  }

  buildDownloadUrl(
    publicGatewayUrl: string,
    artifactId: string,
    ttlMs = this.defaultTtlMs,
  ): string {
    const baseUrl = normalizeBaseUrl(publicGatewayUrl);
    // Concatenate onto the base rather than `new URL("/api/v1/...", baseUrl)`:
    // a leading-slash path is absolute from the origin root, which silently
    // drops a base path prefix (e.g. the embedded/local gateway is mounted
    // under `/lobu`, so the worker must fetch `/lobu/api/v1/files/...`).
    const url = new URL(
      `${baseUrl}/api/v1/files/${encodeURIComponent(artifactId)}`,
    );
    url.searchParams.set("token", this.createDownloadToken(artifactId, ttlMs));
    return url.toString();
  }
}

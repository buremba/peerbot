import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decrypt, encrypt, getErrorMessage } from "@lobu/core";
import baseLogger from "../../utils/logger";

const logger = baseLogger.child({ module: "artifact-store" });

const DEFAULT_ARTIFACTS_DIR = path.join(os.tmpdir(), "lobu-artifacts");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// Keep payload bytes separate from reserved metadata regardless of filename.
const ARTIFACT_PAYLOAD_FILENAME = "content";
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
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

export class ArtifactStorageError extends Error {
  readonly code = "ARTIFACT_STORAGE_UNAVAILABLE";

  constructor(operation: string, cause: unknown) {
    super(
      `Artifact storage ${operation} failed; operator intervention is required`,
      { cause },
    );
    this.name = "ArtifactStorageError";
  }
}

function storageFailure(operation: string, cause: unknown): ArtifactStorageError {
  if (cause instanceof ArtifactStorageError) return cause;
  logger.error(
    { operation, error: getErrorMessage(cause) },
    "Artifact storage operation failed",
  );
  return new ArtifactStorageError(operation, cause);
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
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
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
      "Production artifact storage requires LOBU_ARTIFACTS_DIR on a durable mounted filesystem",
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

  private async readMetadataRecord(
    artifactId: string,
  ): Promise<{ metadata: StoredArtifactMetadata; dirStat: Stats } | null> {
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
      return { metadata: parsed, dirStat };
    } catch {
      return null;
    }
  }

  private async directoryIsUnchanged(
    artifactId: string,
    initial: Stats,
  ): Promise<boolean> {
    try {
      const final = await fs.lstat(this.artifactDir(artifactId));
      return (
        final.isDirectory() &&
        !final.isSymbolicLink() &&
        final.dev === initial.dev &&
        final.ino === initial.ino
      );
    } catch {
      return false;
    }
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
    try {
      const trashDir = this.trashDir();
      await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
      for (const stale of await fs.readdir(trashDir)) {
        await fs.rm(path.join(trashDir, stale), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
      }
    } catch (error) {
      throw storageFailure("cleanup", error);
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
      throw storageFailure("quarantine", error);
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
    if (params.buffer.length > MAX_ARTIFACT_BYTES) {
      throw new RangeError(
        `Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte storage limit`,
      );
    }
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
    let ownsDir = false;
    try {
      // Also creates `baseDir` itself, which the non-recursive mkdir below
      // relies on: a first publish onto an empty mount must not ENOENT.
      await this.drainTrash();
      // Exclusive: a collision on a freshly minted UUID means the directory is
      // not ours, so never adopt it.
      await fs.mkdir(dir, { recursive: false, mode: 0o700 });
      ownsDir = true;
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
      if (ownsDir) {
        try {
          await this.quarantineAndDelete(artifactId);
        } catch (cleanupError) {
          // Message stays path-free like every other surface here: the causes
          // carry the detail, and the filesystem layout is not for callers.
          throw new AggregateError(
            [
              storageFailure("publication", error),
              storageFailure("quarantine", cleanupError),
            ],
            "Artifact publication failed and its partial directory could not be quarantined",
          );
        }
      }
      throw storageFailure("publication", error);
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
    try {
      const record = await this.readMetadataRecord(artifactId);
      if (!record) return null;
      const { metadata, dirStat } = record;
      if (options?.binding && metadata.binding !== options.binding) {
        return null;
      }
      const maxBytes = options?.maxBytes ?? MAX_ARTIFACT_BYTES;
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
      if (!(await this.directoryIsUnchanged(artifactId, dirStat))) return null;
      return { metadata, bytes };
    } catch {
      return null;
    }
  }

  /** Read validated metadata without loading the artifact payload. */
  async inspect(
    artifactId: string,
    options?: { binding?: string },
  ): Promise<StoredArtifactMetadata | null> {
    const record = await this.readMetadataRecord(artifactId);
    if (!record) return null;
    if (options?.binding && record.metadata.binding !== options.binding) {
      return null;
    }
    if (!(await this.directoryIsUnchanged(artifactId, record.dirStat))) return null;
    return record.metadata;
  }

  async delete(artifactId: string): Promise<void> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return;
    try {
      await this.quarantineAndDelete(artifactId);
    } catch (error) {
      throw storageFailure("cleanup", error);
    }
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

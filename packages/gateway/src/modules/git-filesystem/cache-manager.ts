import { exec } from "node:child_process";
import { access, constants, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@peerbot/core";
import { GitHubAppAuth, type RepoInfo } from "./github-app";

const execAsync = promisify(exec);
const logger = createLogger("git-cache");

/**
 * Simple file-based lock for preventing concurrent operations.
 * Uses exclusive file creation (O_EXCL) for atomic lock acquisition.
 */
class FileLock {
  private lockPath: string;
  private acquired = false;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * Acquire the lock. Waits if lock is held by another process.
   * @param timeout - Maximum time to wait in ms (default 30000)
   */
  async acquire(timeout = 30000): Promise<void> {
    const startTime = Date.now();
    const retryDelay = 500;

    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file with O_EXCL (fails if exists)
        const handle = await open(this.lockPath, "wx");
        await handle.close();
        this.acquired = true;
        return;
      } catch (error: any) {
        if (error.code === "EEXIST") {
          // Lock exists, wait and retry
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          throw error;
        }
      }
    }

    throw new Error(
      `Failed to acquire lock at ${this.lockPath} within ${timeout}ms`
    );
  }

  /**
   * Release the lock.
   */
  async release(): Promise<void> {
    if (this.acquired) {
      try {
        await unlink(this.lockPath);
      } catch {
        // Ignore errors during release
      }
      this.acquired = false;
    }
  }
}

export interface CacheResult {
  /** Path to the cached bare repository */
  cachePath: string;
  /** Whether the cache was freshly created or already existed */
  wasCreated: boolean;
}

/**
 * Git cache manager for shared bare repositories.
 * Workers use these as reference repos to save storage space.
 *
 * Cache structure:
 *   /var/cache/peerbot/git/
 *   ├── github.com/
 *   │   ├── owner1/repo1.git/
 *   │   └── owner2/repo2.git/
 *   └── .locks/
 *       └── github.com-owner-repo.lock
 */
export class GitCacheManager {
  private cacheDir: string;
  private locksDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.locksDir = path.join(cacheDir, ".locks");
  }

  /**
   * Initialize the cache directory structure.
   */
  async init(): Promise<void> {
    logger.debug(`Initializing git cache at ${this.cacheDir}`);
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await mkdir(this.locksDir, { recursive: true });
      logger.info(`Git cache initialized at ${this.cacheDir}`);
    } catch (error) {
      logger.error(`Failed to create git cache directory:`, error);
      throw error;
    }
  }

  /**
   * Ensure a repository is cached. Clones if not present, fetches if exists.
   *
   * @param repoUrl - The repository URL to cache
   * @param token - Optional auth token for private repos
   * @returns Path to the cached bare repository
   */
  async ensureCached(repoUrl: string, token?: string): Promise<CacheResult> {
    const repoInfo = GitHubAppAuth.parseRepoUrl(repoUrl);
    const cachePath = this.getCachePath(repoInfo);
    const lockPath = this.getLockPath(repoInfo);

    // Use file lock to prevent concurrent clones of the same repo
    const lock = new FileLock(lockPath);

    try {
      await lock.acquire();

      const exists = await this.cacheExists(cachePath);

      if (exists) {
        // Update existing cache
        await this.fetchCache(cachePath, token);
        return { cachePath, wasCreated: false };
      } else {
        // Clone new bare repository
        await this.cloneToCache(repoUrl, cachePath, token);
        return { cachePath, wasCreated: true };
      }
    } finally {
      await lock.release();
    }
  }

  /**
   * Check if a cache exists for a repository.
   */
  async cacheExists(cachePath: string): Promise<boolean> {
    try {
      await access(cachePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the cache path for a repository.
   */
  getCachePath(repoInfo: RepoInfo): string {
    return path.join(
      this.cacheDir,
      repoInfo.host,
      repoInfo.owner,
      `${repoInfo.repo}.git`
    );
  }

  /**
   * Get the lock file path for a repository.
   */
  private getLockPath(repoInfo: RepoInfo): string {
    const lockName = `${repoInfo.host}-${repoInfo.owner}-${repoInfo.repo}.lock`;
    return path.join(this.locksDir, lockName);
  }

  /**
   * Clone a repository as a bare repository into the cache.
   */
  private async cloneToCache(
    repoUrl: string,
    cachePath: string,
    token?: string
  ): Promise<void> {
    // Ensure parent directory exists
    await mkdir(path.dirname(cachePath), { recursive: true });

    // Build clone URL with token auth if provided
    let cloneUrl = repoUrl;
    if (token) {
      cloneUrl = this.addTokenToUrl(repoUrl, token);
    }

    logger.info(`Cloning ${repoUrl} to cache at ${cachePath}`);

    try {
      // Clone as bare repository (no working directory)
      await execAsync(`git clone --bare "${cloneUrl}" "${cachePath}"`, {
        timeout: 300000, // 5 minute timeout
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // Disable interactive prompts
        },
      });

      logger.info(`Successfully cached ${repoUrl}`);
    } catch (error: any) {
      logger.error(`Failed to clone ${repoUrl} to cache:`, error.message);
      throw new Error(`Failed to cache repository: ${error.message}`);
    }
  }

  /**
   * Fetch updates for an existing cached repository.
   */
  private async fetchCache(cachePath: string, token?: string): Promise<void> {
    logger.debug(`Fetching updates for cache at ${cachePath}`);

    try {
      // Set up credentials for fetch if token provided
      const env: Record<string, string> = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      } as Record<string, string>;

      if (token) {
        // Use credential helper for token auth
        env.GIT_ASKPASS = "true";
        env.GIT_USERNAME = "x-access-token";
        env.GIT_PASSWORD = token;
      }

      await execAsync(`git -C "${cachePath}" fetch --all --prune`, {
        timeout: 120000, // 2 minute timeout
        env,
      });

      logger.debug(`Updated cache at ${cachePath}`);
    } catch (error: any) {
      // Fetch failures are non-fatal - cache may be stale but still usable
      logger.warn(`Failed to update cache at ${cachePath}: ${error.message}`);
    }
  }

  /**
   * Add token authentication to a repository URL.
   */
  private addTokenToUrl(url: string, token: string): string {
    // For HTTPS URLs, insert token as username
    if (url.startsWith("https://")) {
      return url.replace("https://", `https://x-access-token:${token}@`);
    }
    return url;
  }

  /**
   * Parse a repository URL into its components.
   * Delegates to GitHubAppAuth.parseRepoUrl for consistency.
   */
  parseRepoUrl(url: string): RepoInfo {
    return GitHubAppAuth.parseRepoUrl(url);
  }

  /**
   * Get all cached repositories.
   */
  async listCachedRepos(): Promise<RepoInfo[]> {
    const { readdir, stat } = await import("node:fs/promises");
    const repos: RepoInfo[] = [];

    try {
      const hosts = await readdir(this.cacheDir);

      for (const host of hosts) {
        if (host.startsWith(".")) continue; // Skip hidden dirs like .locks

        const hostPath = path.join(this.cacheDir, host);
        const hostStat = await stat(hostPath);
        if (!hostStat.isDirectory()) continue;

        const owners = await readdir(hostPath);
        for (const owner of owners) {
          const ownerPath = path.join(hostPath, owner);
          const ownerStat = await stat(ownerPath);
          if (!ownerStat.isDirectory()) continue;

          const repoFiles = await readdir(ownerPath);
          for (const repoFile of repoFiles) {
            if (repoFile.endsWith(".git")) {
              repos.push({
                host,
                owner,
                repo: repoFile.replace(/\.git$/, ""),
              });
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to list cached repos:`, error);
    }

    return repos;
  }
}

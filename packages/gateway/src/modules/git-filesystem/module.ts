import { readFile } from "node:fs/promises";
import { BaseModule, createLogger } from "@peerbot/core";
import { GitCacheManager } from "./cache-manager";
import { GitHubAppAuth } from "./github-app";

const logger = createLogger("git-filesystem-module");

/**
 * Git Filesystem Module for Peerbot.
 *
 * Provides git repository support for agents:
 * - Clones repositories into worker workspaces
 * - Supports GitHub App authentication for private repos
 * - Supports Personal Access Token (PAT) authentication
 * - Uses shared cache for storage efficiency
 *
 * Environment variables:
 * - GITHUB_APP_ID: GitHub App ID for installation-based auth
 * - GITHUB_APP_PRIVATE_KEY: GitHub App private key (PEM format)
 * - GITHUB_APP_PRIVATE_KEY_PATH: Path to private key file (alternative)
 * - GITHUB_PERSONAL_ACCESS_TOKEN: Global PAT for simpler auth
 * - GIT_CACHE_DIR: Directory for git cache (default: /var/cache/peerbot/git)
 */
export class GitFilesystemModule extends BaseModule {
  name = "git-filesystem";

  private githubAuth: GitHubAppAuth | null = null;
  private cacheManager: GitCacheManager | null = null;
  private globalPat: string | null = null;

  /**
   * Module is enabled if any authentication method is configured,
   * or if we want to support public repos only.
   */
  isEnabled(): boolean {
    // Always enabled - can handle public repos without auth
    // When GITHUB_APP_ID or GITHUB_PERSONAL_ACCESS_TOKEN is set,
    // private repos are also supported
    return true;
  }

  async init(): Promise<void> {
    // Initialize GitHub App auth if configured
    const appId = process.env.GITHUB_APP_ID;
    let privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    // Try loading private key from file if path is provided
    if (!privateKey && process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
      try {
        privateKey = await readFile(
          process.env.GITHUB_APP_PRIVATE_KEY_PATH,
          "utf-8"
        );
        logger.info("Loaded GitHub App private key from file");
      } catch (error) {
        logger.error("Failed to load GitHub App private key from file:", error);
      }
    }

    if (appId && privateKey) {
      this.githubAuth = new GitHubAppAuth(appId, privateKey);
      logger.info("GitHub App authentication initialized");
    } else if (appId && !privateKey) {
      logger.warn(
        "GITHUB_APP_ID set but no private key found. GitHub App auth disabled."
      );
    }

    // Store global PAT if configured
    this.globalPat = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
    if (this.globalPat) {
      logger.info("GitHub Personal Access Token configured");
    }

    // Initialize cache manager
    // Use local cache dir for development (falls back to /var/cache for production)
    const defaultCacheDir =
      process.env.NODE_ENV === "production"
        ? "/var/cache/peerbot/git"
        : process.env.HOME
          ? `${process.env.HOME}/.cache/peerbot/git`
          : "./.peerbot/git-cache";
    const cacheDir = process.env.GIT_CACHE_DIR || defaultCacheDir;
    this.cacheManager = new GitCacheManager(cacheDir);
    await this.cacheManager.init();

    logger.info("Git filesystem module initialized");
  }

  /**
   * Build environment variables for worker container.
   *
   * Expects baseEnv to contain:
   * - GIT_REPO_URL: Repository URL to clone
   * - GIT_BRANCH: Branch to checkout (optional)
   * - GIT_TOKEN: Per-request PAT (optional, highest priority)
   *
   * Adds:
   * - GH_TOKEN: Authentication token for git/gh CLI
   * - GIT_CACHE_PATH: Path to cached bare repo for reference clone
   */
  async buildEnvVars(
    _userId: string,
    agentId: string,
    baseEnv: Record<string, string>
  ): Promise<Record<string, string>> {
    const repoUrl = baseEnv.GIT_REPO_URL;
    const perRequestToken = baseEnv.GIT_TOKEN;

    // No git config - pass through unchanged
    if (!repoUrl) {
      return baseEnv;
    }

    logger.info(`Building git env vars for ${repoUrl} (agent: ${agentId})`);

    let token = "";
    let cachePath = "";

    try {
      const repoInfo = GitHubAppAuth.parseRepoUrl(repoUrl);

      // Auth priority: per-request token > GitHub App > global PAT > no auth
      if (perRequestToken) {
        token = perRequestToken;
        logger.debug("Using per-request token for authentication");
      } else if (this.githubAuth) {
        // Try GitHub App installation token
        const installationId = await this.githubAuth.getInstallationId(
          repoInfo.owner,
          repoInfo.repo
        );
        if (installationId) {
          token = await this.githubAuth.getInstallationToken(installationId);
          logger.debug(
            `Using GitHub App installation token for ${repoInfo.owner}/${repoInfo.repo}`
          );
        } else {
          logger.debug(
            `GitHub App not installed on ${repoInfo.owner}/${repoInfo.repo}`
          );
        }
      }

      // Fall back to global PAT if no token yet
      if (!token && this.globalPat) {
        token = this.globalPat;
        logger.debug("Using global PAT for authentication");
      }

      // Check if public repo (no auth needed for read access)
      if (!token && this.githubAuth) {
        const isPublic = await this.githubAuth.isPublicRepo(
          repoInfo.owner,
          repoInfo.repo
        );
        if (isPublic) {
          logger.debug(
            `${repoInfo.owner}/${repoInfo.repo} is public, no auth needed`
          );
        } else {
          logger.warn(
            `Private repo ${repoInfo.owner}/${repoInfo.repo} but no auth available`
          );
        }
      }

      // Ensure repo is cached (uses token if provided for private repos)
      if (this.cacheManager) {
        try {
          const cacheResult = await this.cacheManager.ensureCached(
            repoUrl,
            token || undefined
          );
          cachePath = cacheResult.cachePath;
          logger.debug(
            `Git cache path: ${cachePath} (${cacheResult.wasCreated ? "created" : "existed"})`
          );
        } catch (error) {
          logger.warn(
            `Failed to cache ${repoUrl}, worker will clone directly:`,
            error
          );
        }
      }
    } catch (error) {
      logger.error(`Failed to build git env vars for ${repoUrl}:`, error);
      // Don't throw - let worker handle the error
    }

    // Remove the per-request token from env (we've processed it)
    const result = { ...baseEnv };
    delete result.GIT_TOKEN;

    // Add processed values
    if (token) {
      result.GH_TOKEN = token;
    }
    if (cachePath) {
      result.GIT_CACHE_PATH = cachePath;
    }

    return result;
  }

  /**
   * Get the GitHub App auth instance (for testing/debugging).
   */
  getGitHubAuth(): GitHubAppAuth | null {
    return this.githubAuth;
  }

  /**
   * Get the cache manager instance (for testing/debugging).
   */
  getCacheManager(): GitCacheManager | null {
    return this.cacheManager;
  }
}

import { spawn } from "node:child_process";
import { BaseModule, createLogger } from "@peerbot/core";

const logger = createLogger("git-filesystem-worker");

interface WorkspaceInitConfig {
  workspaceDir: string;
  username: string;
  sessionKey: string;
}

/**
 * Execute a command and return stdout
 */
async function exec(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    if (options.input) {
      proc.stdin.write(options.input);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Git Filesystem Worker Module
 *
 * Handles git repository cloning and workspace initialization for workers.
 * Uses environment variables set by gateway's GitFilesystemModule:
 * - GIT_REPO_URL: Repository URL to clone
 * - GIT_BRANCH: Branch to checkout (optional)
 * - GH_TOKEN: GitHub token for authentication (optional, for private repos)
 * - GIT_CACHE_PATH: Path to shared cache for reference clone (optional)
 * - GIT_SPARSE_PATHS: Comma-separated sparse checkout paths (optional)
 */
export class GitFilesystemWorkerModule extends BaseModule {
  name = "git-filesystem-worker";

  isEnabled(): boolean {
    // Always enabled - will check for GIT_REPO_URL in initWorkspace
    return true;
  }

  /**
   * Initialize workspace with git repository
   */
  async initWorkspace(config: WorkspaceInitConfig): Promise<void> {
    const repoUrl = process.env.GIT_REPO_URL;

    if (!repoUrl) {
      logger.debug(
        "No GIT_REPO_URL set, skipping git workspace initialization"
      );
      return;
    }

    const cachePath = process.env.GIT_CACHE_PATH;
    const token = process.env.GH_TOKEN;
    const branch = process.env.GIT_BRANCH;
    const sparsePaths = process.env.GIT_SPARSE_PATHS;

    logger.info(`Initializing git workspace: ${repoUrl}`);
    logger.debug(
      `  Cache: ${cachePath || "none"}, Branch: ${branch || "default"}, Sparse: ${sparsePaths || "none"}`
    );

    try {
      // Build clone URL with token auth if provided
      let cloneUrl = repoUrl;
      if (token && repoUrl.startsWith("https://")) {
        // Insert token into HTTPS URL for authentication
        cloneUrl = repoUrl.replace(
          "https://",
          `https://x-access-token:${token}@`
        );
      }

      // Build clone arguments
      const cloneArgs = ["clone"];

      // Use reference clone if cache is available (saves storage and bandwidth)
      if (cachePath) {
        cloneArgs.push("--reference", cachePath);
        // Use --dissociate to copy objects from cache (safer for isolated workers)
        cloneArgs.push("--dissociate");
      }

      // Configure sparse checkout if paths specified
      if (sparsePaths) {
        cloneArgs.push("--sparse");
      }

      // Shallow clone for faster startup
      cloneArgs.push("--depth", "1");

      // Add branch if specified
      if (branch) {
        cloneArgs.push("--branch", branch);
      }

      // Clone URL and destination
      cloneArgs.push(cloneUrl, config.workspaceDir);

      logger.info(`Cloning repository to ${config.workspaceDir}...`);
      await exec("git", cloneArgs);

      // Configure sparse checkout paths if specified
      if (sparsePaths) {
        const paths = sparsePaths.split(",").map((p) => p.trim());
        logger.debug(`Setting up sparse checkout for: ${paths.join(", ")}`);

        // Enable sparse checkout
        await exec("git", ["sparse-checkout", "init"], {
          cwd: config.workspaceDir,
        });

        // Set sparse checkout paths
        await exec("git", ["sparse-checkout", "set", ...paths], {
          cwd: config.workspaceDir,
        });
      }

      // Configure git user for commits
      await exec(
        "git",
        ["config", "user.email", `${config.username}@peerbot.local`],
        { cwd: config.workspaceDir }
      );
      await exec("git", ["config", "user.name", config.username], {
        cwd: config.workspaceDir,
      });

      // Configure credential helper to use token if provided
      if (token) {
        // Store token for push operations
        await exec("git", ["config", "credential.helper", "store"], {
          cwd: config.workspaceDir,
        });

        // Write credentials file for git credential store
        const credentialsPath = `${config.workspaceDir}/.git-credentials`;
        const url = new URL(repoUrl);
        const credLine = `https://x-access-token:${token}@${url.host}\n`;

        // Use git credential store format
        await exec(
          "git",
          [
            "config",
            `credential.${url.origin}.helper`,
            `store --file=${credentialsPath}`,
          ],
          { cwd: config.workspaceDir }
        );

        // Write the credential file
        const { writeFile } = await import("node:fs/promises");
        await writeFile(credentialsPath, credLine, { mode: 0o600 });

        logger.debug("Git credentials configured for push operations");

        // Setup gh CLI authentication if available
        try {
          await exec("gh", ["auth", "status"], { cwd: config.workspaceDir });
          logger.debug("gh CLI already authenticated");
        } catch {
          // Not authenticated, try to login
          try {
            await exec("gh", ["auth", "login", "--with-token"], {
              cwd: config.workspaceDir,
              input: token,
            });
            logger.info("gh CLI authenticated successfully");
          } catch (ghError) {
            // gh CLI not available or login failed - not critical
            logger.debug(
              `gh CLI authentication skipped: ${ghError instanceof Error ? ghError.message : String(ghError)}`
            );
          }
        }
      }

      // Fetch full history if needed for advanced git operations
      // (commented out for now - workers can fetch manually if needed)
      // await exec("git", ["fetch", "--unshallow"], { cwd: config.workspaceDir });

      logger.info(`✅ Git workspace initialized: ${repoUrl}`);
    } catch (error) {
      logger.error(
        `Failed to initialize git workspace: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw - let the worker continue without git workspace
      // The agent can report the error to the user
    }
  }
}

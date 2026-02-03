import { createLogger } from "@peerbot/core";
import { importPKCS8, SignJWT } from "jose";

const logger = createLogger("github-app");

export interface RepoInfo {
  host: string;
  owner: string;
  repo: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: string;
}

export interface Installation {
  id: number;
  account: {
    login: string;
    type: string;
    avatar_url?: string;
  };
  repository_selection: "all" | "selected";
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: {
    login: string;
    avatar_url?: string;
  };
}

export interface Branch {
  name: string;
  protected: boolean;
}

/**
 * GitHub App authentication handler.
 * Generates JWTs and retrieves installation tokens for repository access.
 */
export class GitHubAppAuth {
  private appId: string;
  private privateKey: string;
  private baseUrl = "https://api.github.com";

  constructor(appId: string, privateKey: string) {
    this.appId = appId;
    // Handle escaped newlines in private key
    this.privateKey = privateKey.replace(/\\n/g, "\n");
  }

  /**
   * Generate a JWT for GitHub App API authentication.
   * JWTs are valid for up to 10 minutes.
   */
  async generateJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    const key = await importPKCS8(this.privateKey, "RS256");

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(now - 60) // 60 seconds in the past for clock skew
      .setExpirationTime(now + 10 * 60) // 10 minutes
      .setIssuer(this.appId)
      .sign(key);

    return jwt;
  }

  /**
   * Get the installation ID for a repository.
   * Returns null if the app is not installed on the repository.
   */
  async getInstallationId(owner: string, repo: string): Promise<number | null> {
    try {
      const jwt = await this.generateJwt();

      const response = await fetch(
        `${this.baseUrl}/repos/${owner}/${repo}/installation`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      if (response.status === 404) {
        logger.debug(`GitHub App not installed on ${owner}/${repo}`);
        return null;
      }

      if (!response.ok) {
        const error = await response.text();
        logger.error(
          `Failed to get installation for ${owner}/${repo}: ${response.status} ${error}`
        );
        return null;
      }

      const installation = (await response.json()) as Installation;
      logger.debug(
        `Found installation ${installation.id} for ${owner}/${repo}`
      );
      return installation.id;
    } catch (error) {
      logger.error(
        `Error getting installation ID for ${owner}/${repo}:`,
        error
      );
      return null;
    }
  }

  /**
   * Generate a short-lived installation access token for repository access.
   * Installation tokens are valid for 1 hour.
   */
  async getInstallationToken(installationId: number): Promise<string> {
    const jwt = await this.generateJwt();

    const response = await fetch(
      `${this.baseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get installation token: ${response.status} ${error}`
      );
    }

    const data = (await response.json()) as InstallationTokenResponse;
    logger.debug(`Generated installation token expiring at ${data.expires_at}`);
    return data.token;
  }

  /**
   * Check if a repository is public.
   * Public repos don't require authentication for read access.
   */
  async isPublicRepo(owner: string, repo: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (response.status === 404) {
        // Could be private or non-existent
        return false;
      }

      if (!response.ok) {
        logger.warn(
          `Failed to check if ${owner}/${repo} is public: ${response.status}`
        );
        return false;
      }

      const data = (await response.json()) as { private: boolean };
      return !data.private;
    } catch (error) {
      logger.error(`Error checking if ${owner}/${repo} is public:`, error);
      return false;
    }
  }

  /**
   * List all installations of this GitHub App.
   * Returns all organizations/users where the app is installed.
   */
  async listInstallations(): Promise<Installation[]> {
    try {
      const jwt = await this.generateJwt();

      const response = await fetch(`${this.baseUrl}/app/installations`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error(
          `Failed to list installations: ${response.status} ${error}`
        );
        return [];
      }

      const installations = (await response.json()) as Installation[];
      logger.debug(`Found ${installations.length} installations`);
      return installations;
    } catch (error) {
      logger.error("Error listing installations:", error);
      return [];
    }
  }

  /**
   * List repositories accessible to a specific installation.
   */
  async listInstallationRepos(installationId: number): Promise<Repository[]> {
    try {
      const token = await this.getInstallationToken(installationId);

      const response = await fetch(
        `${this.baseUrl}/installation/repositories`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error(
          `Failed to list repos for installation ${installationId}: ${response.status} ${error}`
        );
        return [];
      }

      const data = (await response.json()) as { repositories: Repository[] };
      logger.debug(
        `Found ${data.repositories.length} repos for installation ${installationId}`
      );
      return data.repositories;
    } catch (error) {
      logger.error(
        `Error listing repos for installation ${installationId}:`,
        error
      );
      return [];
    }
  }

  /**
   * List branches for a repository.
   * Uses installation token if installationId provided, otherwise uses public API.
   */
  async listBranches(
    owner: string,
    repo: string,
    installationId?: number
  ): Promise<Branch[]> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };

      if (installationId) {
        const token = await this.getInstallationToken(installationId);
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(
        `${this.baseUrl}/repos/${owner}/${repo}/branches`,
        { headers }
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error(
          `Failed to list branches for ${owner}/${repo}: ${response.status} ${error}`
        );
        return [];
      }

      const branches = (await response.json()) as Branch[];
      logger.debug(`Found ${branches.length} branches for ${owner}/${repo}`);
      return branches;
    } catch (error) {
      logger.error(`Error listing branches for ${owner}/${repo}:`, error);
      return [];
    }
  }

  /**
   * Parse a GitHub repository URL into its components.
   * Supports both HTTPS and SSH URLs.
   *
   * @example
   * parseRepoUrl("https://github.com/owner/repo")
   * // => { host: "github.com", owner: "owner", repo: "repo" }
   *
   * parseRepoUrl("git@github.com:owner/repo.git")
   * // => { host: "github.com", owner: "owner", repo: "repo" }
   */
  static parseRepoUrl(url: string): RepoInfo {
    // Handle HTTPS URLs: https://github.com/owner/repo(.git)?
    const httpsMatch = url.match(
      /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/
    );
    if (httpsMatch) {
      return {
        host: httpsMatch[1]!,
        owner: httpsMatch[2]!,
        repo: httpsMatch[3]!,
      };
    }

    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        host: sshMatch[1]!,
        owner: sshMatch[2]!,
        repo: sshMatch[3]!,
      };
    }

    throw new Error(`Invalid repository URL format: ${url}`);
  }
}

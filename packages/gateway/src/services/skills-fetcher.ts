import { createLogger } from "@peerbot/core";

const logger = createLogger("skills-fetcher");

/**
 * Parsed skill metadata from SKILL.md file
 */
export interface SkillMetadata {
  name: string;
  description: string;
  content: string;
}

/**
 * Curated skill entry for the skills dropdown
 */
export interface CuratedSkill {
  repo: string;
  name: string;
  description: string;
  category: string;
}

/**
 * Skill entry from skills.sh API
 */
export interface SkillsShSkill {
  id: string; // Full path like "vercel-labs/skills/find-skills"
  skillId: string; // Short name
  name: string; // Display name
  installs: number; // Popularity count
  source: string; // Origin/namespace
}

/**
 * Response from skills.sh API
 */
interface SkillsShApiResponse {
  skills: SkillsShSkill[];
  hasMore: boolean;
}

/**
 * Response from skills.sh search API
 */
interface SkillsShSearchResponse {
  query: string;
  searchType: string;
  skills: SkillsShSkill[];
}

/**
 * Service for fetching SKILL.md content from GitHub repositories.
 *
 * Responsibilities:
 * - Fetch SKILL.md from owner/repo paths via GitHub raw content API
 * - Parse YAML frontmatter for name/description
 * - Cache content with TTL
 * - Provide curated popular skills list
 */
export class SkillsFetcherService {
  private cache: Map<string, { data: SkillMetadata; fetchedAt: number }>;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Cache for skills.sh API results
  private skillsShCache: { skills: SkillsShSkill[]; fetchedAt: number } | null =
    null;
  private readonly SKILLS_SH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private readonly SKILLS_SH_API_URL = "https://skills.sh/api/skills";
  private readonly SKILLS_SH_SEARCH_URL = "https://skills.sh/api/search";

  /**
   * Curated list of popular skills from skills.sh
   * These appear in the settings page dropdown for easy discovery
   * Note: repo format matches skills.sh IDs (owner/repo/skillName)
   */
  static readonly CURATED_SKILLS: CuratedSkill[] = [
    // Documents
    {
      repo: "anthropics/skills/pdf",
      name: "pdf",
      description: "PDF document processing and generation",
      category: "Documents",
    },
    {
      repo: "anthropics/skills/docx",
      name: "docx",
      description: "Word document creation and editing",
      category: "Documents",
    },
    {
      repo: "anthropics/skills/xlsx",
      name: "xlsx",
      description: "Excel spreadsheet creation",
      category: "Documents",
    },
    {
      repo: "anthropics/skills/pptx",
      name: "pptx",
      description: "PowerPoint presentation creation",
      category: "Documents",
    },
    // Development
    {
      repo: "anthropics/skills/frontend-design",
      name: "frontend-design",
      description: "Frontend design best practices",
      category: "Development",
    },
    {
      repo: "anthropics/skills/mcp-builder",
      name: "mcp-builder",
      description: "Build MCP servers",
      category: "Development",
    },
    // Creative
    {
      repo: "remotion-dev/skills/remotion",
      name: "remotion",
      description: "Video creation with React",
      category: "Creative",
    },
  ];

  constructor() {
    this.cache = new Map();
  }

  /**
   * Fetch SKILL.md content from GitHub.
   * First tries common URL patterns, then falls back to GitHub tree API to find exact path.
   */
  async fetchSkill(repo: string): Promise<SkillMetadata> {
    // Check cache
    const cached = this.cache.get(repo);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      logger.debug(`Returning cached skill: ${repo}`);
      return cached.data;
    }

    // Build list of possible GitHub URLs to try
    const urls = this.buildPossibleGitHubUrls(repo);
    logger.info(`Fetching skill from ${repo}, trying ${urls.length} URLs`);

    // Try common patterns first (faster)
    for (const url of urls) {
      try {
        logger.debug(`Trying: ${url}`);
        const response = await fetch(url, {
          headers: { Accept: "text/plain" },
        });

        if (response.ok) {
          const content = await response.text();
          const metadata = this.parseSkillContent(content, repo);

          // Cache result
          this.cache.set(repo, { data: metadata, fetchedAt: Date.now() });
          logger.info(`Cached skill: ${repo} (${metadata.name}) from ${url}`);

          return metadata;
        }
      } catch {
        // Continue to next URL
      }
    }

    // Fallback: Use GitHub tree API to find SKILL.md
    logger.info(`Common patterns failed, using GitHub tree API for ${repo}`);
    const skillPath = await this.findSkillPathViaTreeApi(repo);

    if (skillPath) {
      const parts = repo.split("/");
      const owner = parts[0] || "";
      const repoName = parts[1] || "";
      const url = `https://raw.githubusercontent.com/${owner}/${repoName}/main/${skillPath}`;

      const response = await fetch(url, { headers: { Accept: "text/plain" } });
      if (response.ok) {
        const content = await response.text();
        const metadata = this.parseSkillContent(content, repo);

        this.cache.set(repo, { data: metadata, fetchedAt: Date.now() });
        logger.info(`Cached skill: ${repo} (${metadata.name}) via tree API`);

        return metadata;
      }
    }

    throw new Error(`Failed to fetch skill from ${repo}: SKILL.md not found`);
  }

  /**
   * Use GitHub's tree API to find SKILL.md path for a skill.
   * This is slower but reliable when common patterns don't match.
   */
  private async findSkillPathViaTreeApi(repo: string): Promise<string | null> {
    const parts = repo.split("/");
    if (parts.length < 2) return null;

    const owner = parts[0] || "";
    const repoName = parts[1] || "";
    const skillName = parts.length > 2 ? parts[parts.length - 1] : null;

    try {
      const treeUrl = `https://api.github.com/repos/${owner}/${repoName}/git/trees/main?recursive=1`;
      const response = await fetch(treeUrl, {
        headers: { Accept: "application/vnd.github+json" },
      });

      if (!response.ok) {
        logger.warn(`GitHub tree API returned ${response.status} for ${repo}`);
        return null;
      }

      interface TreeItem {
        path: string;
        type: string;
      }
      const data = (await response.json()) as { tree: TreeItem[] };
      const skillMdFiles = data.tree
        .filter(
          (item) => item.path.endsWith("/SKILL.md") || item.path === "SKILL.md"
        )
        .map((item) => item.path);

      if (skillMdFiles.length === 0) return null;

      // If we have a skill name, find the matching SKILL.md
      if (skillName) {
        const match = skillMdFiles.find((path) =>
          path.includes(`/${skillName}/SKILL.md`)
        );
        if (match) return match;
      }

      // Return first SKILL.md found
      return skillMdFiles[0] || null;
    } catch (error) {
      logger.error(`GitHub tree API failed for ${repo}`, { error });
      return null;
    }
  }

  /**
   * Build list of possible GitHub raw content URLs to try.
   * Skills.sh IDs like "anthropics/skills/pdf" may have SKILL.md at various locations:
   * - /skills/{name}/SKILL.md
   * - /.claude/skills/{name}/SKILL.md
   * - /{path}/SKILL.md
   * - /SKILL.md
   */
  private buildPossibleGitHubUrls(repo: string): string[] {
    const parts = repo.split("/");

    if (parts.length < 2) {
      throw new Error(`Invalid skill repo format: ${repo}`);
    }

    const owner = parts[0] || "";
    const repoName = parts[1] || "";
    const base = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;
    const urls: string[] = [];

    // If only owner/repo, try root SKILL.md
    if (parts.length === 2) {
      urls.push(`${base}/SKILL.md`);
      urls.push(`${base}/skills/SKILL.md`);
      urls.push(`${base}/.claude/skills/SKILL.md`);
      return urls;
    }

    // For owner/repo/skillName format (e.g., anthropics/skills/pdf)
    const skillName = parts[parts.length - 1] || "";
    const path = parts.slice(2).join("/");

    // Try common locations in order of likelihood
    urls.push(`${base}/skills/${skillName}/SKILL.md`);
    urls.push(`${base}/.claude/skills/${skillName}/SKILL.md`);
    urls.push(`${base}/${path}/SKILL.md`);
    urls.push(`${base}/SKILL.md`);

    return urls;
  }

  /**
   * Parse SKILL.md content and extract YAML frontmatter.
   * Frontmatter format:
   * ---
   * name: skill-name
   * description: What this skill does
   * ---
   */
  private parseSkillContent(content: string, repo: string): SkillMetadata {
    // Extract YAML frontmatter (between --- markers)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    // Default name from repo path
    let name = repo.split("/").pop() || "unknown";
    let description = "";

    if (frontmatterMatch?.[1]) {
      const frontmatter = frontmatterMatch[1];

      // Simple YAML parsing for name and description
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      if (nameMatch?.[1]) {
        name = nameMatch[1].trim();
      }

      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch?.[1]) {
        description = descMatch[1].trim();
      }
    }

    return { name, description, content };
  }

  /**
   * Get list of curated popular skills for the settings dropdown.
   */
  getCuratedSkills(): CuratedSkill[] {
    return SkillsFetcherService.CURATED_SKILLS;
  }

  /**
   * Clear cached skill content.
   * @param repo - Specific repo to clear, or all if not provided
   */
  clearCache(repo?: string): void {
    if (repo) {
      this.cache.delete(repo);
      logger.debug(`Cleared cache for: ${repo}`);
    } else {
      this.cache.clear();
      logger.debug("Cleared all skill cache");
    }
  }

  /**
   * Fetch all skills from skills.sh API (with caching).
   * The API doesn't support server-side search, so we fetch all and filter client-side.
   */
  async fetchSkillsFromRegistry(): Promise<SkillsShSkill[]> {
    // Check cache
    if (
      this.skillsShCache &&
      Date.now() - this.skillsShCache.fetchedAt < this.SKILLS_SH_CACHE_TTL_MS
    ) {
      logger.debug(
        `Returning cached skills.sh data (${this.skillsShCache.skills.length} skills)`
      );
      return this.skillsShCache.skills;
    }

    logger.info("Fetching skills from skills.sh API...");

    try {
      // Fetch first page
      const response = await fetch(this.SKILLS_SH_API_URL);
      if (!response.ok) {
        throw new Error(`skills.sh API returned ${response.status}`);
      }

      const data = (await response.json()) as SkillsShApiResponse;
      const allSkills = data.skills;

      // The API returns skills sorted by popularity, top ~50 is usually enough
      // If you need more, you could paginate, but for search purposes top skills suffice
      logger.info(`Fetched ${allSkills.length} skills from skills.sh`);

      // Cache the results
      this.skillsShCache = {
        skills: allSkills,
        fetchedAt: Date.now(),
      };

      return allSkills;
    } catch (error) {
      logger.error("Failed to fetch skills from skills.sh", { error });
      // Return empty array on error, don't break the UI
      return [];
    }
  }

  /**
   * Search skills from skills.sh registry using their search API.
   * @param query - Search query (fuzzy matched against skill names and repos)
   * @param limit - Maximum number of results (default 20)
   */
  async searchSkills(query: string, limit = 20): Promise<SkillsShSkill[]> {
    if (!query.trim()) {
      // Return top skills by popularity if no query
      const allSkills = await this.fetchSkillsFromRegistry();
      return allSkills.slice(0, limit);
    }

    logger.info(`Searching skills.sh for: ${query}`);

    try {
      const url = `${this.SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`skills.sh search API returned ${response.status}`);
      }

      const data = (await response.json()) as SkillsShSearchResponse;
      logger.info(`Found ${data.skills.length} skills for query: ${query}`);

      return data.skills.slice(0, limit);
    } catch (error) {
      logger.error("Failed to search skills from skills.sh", { error, query });
      // Fall back to client-side filtering on error
      const allSkills = await this.fetchSkillsFromRegistry();
      const lowerQuery = query.toLowerCase().trim();
      return allSkills
        .filter(
          (skill) =>
            skill.name.toLowerCase().includes(lowerQuery) ||
            skill.skillId.toLowerCase().includes(lowerQuery) ||
            skill.id.toLowerCase().includes(lowerQuery)
        )
        .slice(0, limit);
    }
  }
}

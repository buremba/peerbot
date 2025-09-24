#!/usr/bin/env bun

import type { WebClient } from "@slack/web-api";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import { generateGitHubAuthUrl } from "../utils/github-utils";
import { getUserGitHubInfo } from "../slack/handlers/github-handler";
import { generateDeterministicActionId } from "./blockkit-processor";
import logger from "../logger";

/**
 * Generate GitHub action buttons for the session branch
 */
export async function generateGitHubActionButtons(
  userId: string,
  gitBranch: string | undefined,
  hasGitChanges: boolean | undefined,
  pullRequestUrl: string | undefined,
  userMappings: Map<string, string>,
  repoManager: GitHubRepositoryManager,
  slackClient?: WebClient
): Promise<any[] | undefined> {
  try {
    logger.debug(
      `Generating GitHub action buttons for user ${userId}, gitBranch: ${gitBranch}, hasGitChanges: ${hasGitChanges}, pullRequestUrl: ${pullRequestUrl}`
    );

    // If no git branch provided, don't show buttons
    if (!gitBranch) {
      logger.debug(`No git branch provided, skipping GitHub buttons`);
      return undefined;
    }

    // Check if we're on a session branch (indicates work has been done)
    const isSessionBranch = gitBranch.startsWith("claude/");

    // Show buttons if:
    // 1. There are uncommitted changes, OR
    // 2. An existing PR exists, OR
    // 3. We're on a session branch (even if all changes are committed)
    if (!hasGitChanges && !pullRequestUrl && !isSessionBranch) {
      logger.debug(
        `No git changes, no PR, and not a session branch, skipping GitHub buttons`
      );
      return undefined;
    }

    // Get GitHub username from Slack user ID
    let githubUsername = userMappings.get(userId);
    if (!githubUsername && slackClient) {
      // Create user mapping on-demand if not found
      logger.debug(`Creating on-demand user mapping for user ${userId}`);
      try {
        const userInfo = await slackClient.users.info({ user: userId });
        const user = userInfo.user;

        let username =
          user.profile?.display_name || user.profile?.real_name || user.name;
        if (!username) {
          username = userId;
        }

        // Sanitize username for GitHub
        username = username
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-|-$/g, "");

        username = `user-${username}`;
        userMappings.set(userId, username);
        githubUsername = username;

        logger.info(`Created user mapping: ${userId} -> ${username}`);
      } catch (error) {
        logger.error(`Failed to create user mapping for ${userId}:`, error);
        const fallbackUsername = `user-${userId.substring(0, 8)}`;
        userMappings.set(userId, fallbackUsername);
        githubUsername = fallbackUsername;
      }
    }

    if (!githubUsername) {
      logger.debug(`No GitHub username mapping found for user ${userId}`);
      return undefined;
    }

    // Get repository information, create if needed
    const repository = await repoManager.ensureUserRepository(githubUsername);
    if (!repository) {
      logger.debug(`No repository found for GitHub user ${githubUsername}`);
      return undefined;
    }

    const repoUrl = repository.repositoryUrl;
    const repoPath = repoUrl.replace("https://github.com/", "");

    logger.info(
      `Showing action buttons for branch: ${gitBranch}, PR exists: ${!!pullRequestUrl}`
    );

    // Check if user has GitHub authentication
    const githubInfo = await getUserGitHubInfo(userId);
    const hasGitHubAuth = !!githubInfo.token;

    // Generate auth URL for GitHub OAuth
    const authUrl = generateGitHubAuthUrl(userId);

    const buttons: any[] = [];

    // Show appropriate PR button based on whether PR exists
    if (pullRequestUrl) {
      // PR exists - show view button with green checkmark
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "🔀 View Pull Request" },
        url: pullRequestUrl,
        action_id: generateDeterministicActionId(
          `view_pr_${repoPath}_${gitBranch}`,
          "github_view_pr"
        ),
      });
    } else if (hasGitChanges || isSessionBranch) {
      // Build dynamic prompt based on GitHub auth status
      let prompt: string;

      if (hasGitHubAuth) {
        // User is authenticated - agent should handle forking if needed
        prompt = `📝 *Create Pull Request*

• Review the code and cleanup any temporary files
• Commit all changes to Git
• Try to push: \`git push -u origin ${gitBranch}\`
• If push fails due to permissions:
  - Fork the repository: \`gh repo fork --clone=false\`
  - Add fork as remote: \`git remote add fork $(gh repo fork --clone=false 2>&1 | grep -o 'https://[^ ]*')\`
  - Push to fork: \`git push -u fork ${gitBranch}\`
• Create PR: \`gh pr create --web\``;
      } else {
        // User is not authenticated - provide auth link
        prompt = `📝 *Create Pull Request*

• Review the code and cleanup any temporary files
• Commit all changes to Git
• Try to push: \`git push -u origin ${gitBranch}\`
• If you get a permission error (403), ask the user to authenticate [here](${authUrl})
• After authentication, retry the push
• Create PR: \`gh pr create --web\``;
      }

      // No PR but has changes OR on a session branch - show create PR button
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "🔀 Create Pull Request" },
        action_id: generateDeterministicActionId(
          `pr_${repoPath}_${gitBranch}`,
          "github_pr"
        ),
        value: JSON.stringify({
          action: "create_pr",
          repo: repoPath,
          branch: gitBranch,
          prompt: prompt,
        }),
      });
    }

    return buttons.length > 0 ? buttons : undefined;
  } catch (_error) {
    // Return undefined on error - this will result in no action buttons being added
    return undefined;
  }
}
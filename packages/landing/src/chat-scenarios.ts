/**
 * Lobu-specific chat scenarios used by the platform docs pages to showcase
 * real agent interactions. Content reflects actual Lobu architecture:
 * - Domain allowlist / gateway proxy enforcement
 * - MCP tool approval flow
 * - Provider installation with real provider IDs from providers.json
 * - Settings-page link buttons
 */

import type { UseCase } from "./types";

/**
 * Permission flow — the gateway proxy blocks outbound requests to domains
 * not on the allowlist. Workers must request access and the user approves
 * via an in-chat button.
 */
export const PERMISSION_SCENARIO: UseCase = {
  id: "permission",
  tabLabel: "Permission",
  title: "Domain permission flow",
  description:
    "Agents request network access through the gateway proxy. Users approve or deny in-chat.",
  settingsLabel: "Domains, MCP proxy, and tool permissions",
  chatLabel: "Agent requests github.com access",
  botName: "Coding",
  botInitial: "C",
  botColor: "#f97316",
  messages: [
    {
      role: "user",
      text: "List open PRs in lobu-ai/lobu",
    },
    {
      role: "bot",
      text: "Can't reach github.com — not in the agent's allowed domains.\n\nGrant access?",
      buttons: [{ label: "Allow github.com", action: "link" }],
    },
    {
      role: "user",
      text: "Allow for 1 hour",
    },
    {
      role: "bot",
      text: "Added github.com to allowed domains.\n\n3 open PRs in lobu-ai/lobu:\n• #214 Fix worker memory leak\n• #219 Telegram adapter retries\n• #223 Add Bedrock provider",
    },
  ],
};

/**
 * Skill install flow — user asks for a capability, agent proposes installing
 * a Lobu provider (real ID from providers.json), OAuth flows handled by
 * Lobu, user approves via in-chat button.
 */
export const SKILL_INSTALL_SCENARIO: UseCase = {
  id: "skill-install",
  tabLabel: "Skill",
  title: "Install a skill",
  description:
    "Agents propose Lobu skills when they need a capability. Lobu manages OAuth and API keys.",
  settingsLabel: "Skills and integrations",
  chatLabel: "Agent installs linear skill",
  botName: "Ops Assistant",
  botInitial: "O",
  botColor: "#8b5cf6",
  messages: [
    {
      role: "user",
      text: "Summarize my active Linear sprint",
    },
    {
      role: "bot",
      text: "I need the `linear` skill to query Linear.\n\nIt bundles the Linear MCP and handles OAuth via Lobu.",
      buttons: [{ label: "Install linear", action: "link" }],
    },
    {
      role: "user",
      text: "Go ahead",
    },
    {
      role: "bot",
      text: 'Installed and connected.\n\nSprint "Week 15" (68% done):\n• 11 merged, 3 in review, 2 todo\n• Blocked: AUTH-234 (design)\n• At risk: API-89 (due tomorrow)',
    },
  ],
};

/**
 * Settings link flow — agents open a platform-scoped settings page for
 * config that shouldn't happen in chat (model picker, system prompt, etc.)
 */
export const SETTINGS_LINK_SCENARIO: UseCase = {
  id: "settings-link",
  tabLabel: "Settings",
  title: "Open settings",
  description:
    "Agents expose a settings link for model, system prompt, schedules, and permissions.",
  settingsLabel: "Pick provider, model, and memory",
  chatLabel: "Agent opens settings page",
  botName: "Assistant",
  botInitial: "A",
  botColor: "#0ea5e9",
  messages: [
    {
      role: "user",
      text: "Switch to Claude Sonnet",
    },
    {
      role: "bot",
      text: "You can change the model from your settings — opens a scoped page with your current agent config.",
      buttons: [{ label: "Open Settings", action: "settings" }],
    },
    {
      role: "user",
      text: "Done — set to claude-sonnet-4-6",
    },
    {
      role: "bot",
      text: "Now running on claude-sonnet-4-6 via OpenRouter.\n\nNext messages will use the new model.",
    },
  ],
};

export const PLATFORM_SCENARIOS: UseCase[] = [
  PERMISSION_SCENARIO,
  SKILL_INSTALL_SCENARIO,
  SETTINGS_LINK_SCENARIO,
];

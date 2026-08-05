/**
 * Conventional agent ids, kept as read-only routing conventions.
 *
 * Agents are no longer auto-provisioned — these constants only let legacy
 * installs (which were seeded with these agents) keep working:
 *
 *   - `owletto-default`: the historical default personal agent. Bare chat
 *     requests without an agentId still resolve to it when an org happens
 *     to have it (see gateway/routes/public/agent.ts).
 *   - `lobu-builder`: the historical Builder/console agent. Used as a
 *     fallback when resolving an org's system agent (see
 *     gateway/connections/slack-claim-onboarding.ts).
 *
 * Nothing creates agents with these ids anymore.
 */

export const DEFAULT_AGENT_ID = "owletto-default";
export const BUILDER_AGENT_ID = "lobu-builder";

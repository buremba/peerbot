import type { AgentConfigStore } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import {
  resolveSettingsLookupUserId,
  verifyOwnedAgentAccess,
} from "../shared/agent-ownership";

export interface AgentAccessConfig {
  userAgentsStore: UserAgentsStore;
  agentMetadataStore: Pick<AgentConfigStore, "getMetadata">;
}

export async function verifyAgentAccess(
  session: SettingsTokenPayload,
  agentId: string,
  config: AgentAccessConfig
): Promise<boolean> {
  const result = await verifyOwnedAgentAccess(session, agentId, config);
  return result.authorized;
}

export { resolveSettingsLookupUserId };

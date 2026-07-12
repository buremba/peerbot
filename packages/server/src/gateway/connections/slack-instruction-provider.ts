import type { InstructionContext } from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import { BaseInstructionProvider } from "../services/instruction-service.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";

export class SlackInstructionProvider extends BaseInstructionProvider {
  readonly name = "slack-identity";
  readonly priority = 20;

  constructor(private readonly manager: ChatInstanceManager) {
    super();
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    // Defense in depth: no Slack identity without an org. `listConnections` is
    // agent-scoped and — without an ambient org — would return ANOTHER tenant's
    // newest Slack connection for a shared agent id (leaking foreign
    // botUsername/botUserId). Require the org and run the read INSIDE it so it's
    // actually tenant-scoped. (The InstructionService also gates this provider
    // out when `orgScoped === false`; this is the belt to that suspenders.)
    if (!context.organizationId) return "";
    const connections = await orgContext.run(
      { organizationId: context.organizationId },
      () =>
        this.manager.listConnections({
          platform: "slack",
          agentId: context.agentId,
        })
    );
    const connection = connections[0];
    if (!connection) return "";

    const botUsername = connection.metadata?.botUsername as string | undefined;
    const botUserId = connection.metadata?.botUserId as string | undefined;
    if (!botUsername && !botUserId) return "";

    const lines: string[] = ["**Slack identity:**"];
    if (botUsername && botUserId) {
      lines.push(
        `- You are reachable in Slack as \`@${botUsername}\` (user ID \`${botUserId}\`).`
      );
    } else if (botUsername) {
      lines.push(`- You are reachable in Slack as \`@${botUsername}\`.`);
    } else if (botUserId) {
      lines.push(`- Your Slack user ID is \`${botUserId}\`.`);
    }
    if (botUserId) {
      lines.push(
        `- Mentions of \`<@${botUserId}>\` (or the bare \`@${botUserId}\`) refer to *you*; the gateway strips them before delivery, so anything you still see is incidental — do not treat your own ID as a stranger.`
      );
    }
    return lines.join("\n");
  }
}

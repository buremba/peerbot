import type { InstructionContext, InstructionProvider } from "@lobu/core";
import type { ChatInstanceManager } from "./chat-instance-manager";

export class SlackInstructionProvider implements InstructionProvider {
  name = "slack-identity";
  priority = 20;

  constructor(private readonly manager: ChatInstanceManager) {}

  async getInstructions(context: InstructionContext): Promise<string> {
    const connections = await this.manager.listConnections({
      platform: "slack",
      templateAgentId: context.agentId,
    });
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

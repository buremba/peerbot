import { createLogger } from "./logger";

const logger = createLogger("command-registry");

/**
 * Context passed to command handlers.
 * Shaped to match OpenClaw's registerCommand() API for future migration.
 */
export interface CommandContext {
  userId: string;
  channelId: string;
  /** Workspace/team id for platforms that have one (Slack). Undefined elsewhere. */
  teamId?: string;
  /** True if this is a group/channel rather than a 1:1 DM with the bot. */
  isGroup?: boolean;
  conversationId?: string;
  connectionId?: string;
  organizationId?: string;
  agentId?: string;
  args: string;
  reply: (
    text: string,
    options?: { url?: string; urlLabel?: string; webApp?: boolean }
  ) => Promise<void>;
  platform: string;
}

/**
 * A registered command definition.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  handler: (ctx: CommandContext) => Promise<void>;
}

/**
 * Shared command registry used by all platform adapters.
 * Matches OpenClaw's registerCommand() shape so migration is a simple swap.
 */
export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();

  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);
    logger.debug({ command: cmd.name }, "Command registered");
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * Try to handle a command by name. Returns true if handled.
   */
  async tryHandle(name: string, ctx: CommandContext): Promise<boolean> {
    const cmd = this.commands.get(name);
    if (!cmd) return false;

    try {
      await cmd.handler(ctx);
      return true;
    } catch (error) {
      logger.error(
        { command: name, error: String(error) },
        "Command handler failed"
      );
      // The fallback reply itself may throw (dead webhook, network error,
      // bot kicked from the channel). The command was still handled — we
      // logged the failure — so don't let a reply failure bubble out and
      // make tryHandle reject, which would then double-report the original
      // handler error to the caller.
      try {
        await ctx.reply(
          "Sorry, something went wrong executing that command. Please try again."
        );
      } catch (replyError) {
        logger.error(
          { command: name, error: String(replyError) },
          "Failed to send error reply for failed command"
        );
      }
      return true;
    }
  }
}

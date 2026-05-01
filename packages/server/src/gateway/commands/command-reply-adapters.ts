import type { CommandContext } from "@lobu/core";

export function createChatReply(
  postFn: (content: any) => Promise<void>
): CommandContext["reply"] {
  return async (text, options) => {
    if (options?.url) {
      const { Card, CardText, Actions, LinkButton } = await import("chat");
      const linkButton: any = LinkButton({
        url: options.url,
        label: options.urlLabel || "Open",
      });
      if (options.webApp) {
        linkButton.webApp = true;
      }
      const card = Card({
        children: [CardText(text), Actions([linkButton])],
      });
      await postFn({
        card,
        fallbackText: `${text}\n${options.urlLabel || "Open"}: ${options.url}`,
      });
      return;
    }
    await postFn(text);
  };
}

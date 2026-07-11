/**
 * Extract settings link buttons from markdown content.
 *
 * Scans for markdown links pointing to `/connect/claim?claim=...` URLs and
 * returns them as structured button data, stripping the link syntax
 * from the content so platforms can render native buttons instead.
 */

import { Actions, Card, CardText, LinkButton } from "chat";

const SETTINGS_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/[^)]*\/(?:connect\/claim|agent)\?claim=[^)]+)\)/g;

/**
 * Returns true when the URL points to a loopback address that
 * Telegram (and other platforms) reject for inline keyboard buttons.
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1"
    );
  } catch {
    return true;
  }
}

interface ExtractedLinkButton {
  text: string;
  url: string;
}

/**
 * Turn a rendered error/notice (`text` + optional CTA `url`/`label`) into the
 * post payload a Chat SDK target accepts — a `{ card, fallbackText }` with a
 * native link button when the URL is real, or a plain string otherwise. THE one
 * place a CTA becomes a card, shared by the terminal-error bridge and the
 * pre-enqueue model-provider preflight so both surfaces render identically
 * (native button on Slack/Telegram/web, never a bare URL in prose).
 *
 * Falls back to text when there's no URL or it's a loopback address (some
 * platforms reject localhost inline-button URLs) — the URL is appended so the
 * action is still reachable.
 */
export function buildCtaCardPayload(args: {
  text: string;
  url?: string | null;
  label?: string;
}): { card: unknown; fallbackText: string } | string {
  const { text } = args;
  const label = args.label ?? "Open settings";
  if (!args.url || isLocalhostUrl(args.url)) {
    return args.url ? `${text}\n\n${label}: ${args.url}` : text;
  }
  return {
    card: Card({
      children: [
        CardText(text),
        Actions([LinkButton({ url: args.url, label })]),
      ],
    }),
    fallbackText: `${text}\n\n${label}: ${args.url}`,
  };
}

/**
 * Extract `[label](settingsUrl)` markdown links and return them as
 * structured buttons.  The link syntax is replaced with just the label
 * text so the surrounding prose still reads naturally.
 */
export function extractSettingsLinkButtons(content: string): {
  processedContent: string;
  linkButtons: ExtractedLinkButton[];
} {
  const linkButtons: ExtractedLinkButton[] = [];

  const processedContent = content.replace(
    SETTINGS_LINK_RE,
    (_match, text: string, url: string) => {
      if (!isLocalhostUrl(url)) {
        linkButtons.push({ text, url });
      }
      // Replace the markdown link with just the label text
      return text;
    }
  );

  return { processedContent, linkButtons };
}

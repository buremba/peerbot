/**
 * Extract settings link buttons from markdown content.
 *
 * Scans for markdown links pointing to `/connect/claim?claim=...` URLs and
 * returns them as structured button data, stripping the link syntax
 * from the content so platforms can render native buttons instead.
 */

const SETTINGS_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/[^)]*\/(?:connect\/claim|agent)\?claim=[^)]+)\)/g;

/**
 * Returns true when the URL points to a loopback address that
 * Telegram (and other platforms) reject for inline keyboard buttons.
 */
function isLocalhostUrl(url: string): boolean {
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

export interface LinkButton {
  text: string;
  url: string;
}

/**
 * Extract `[label](settingsUrl)` markdown links and return them as
 * structured buttons.  The link syntax is replaced with just the label
 * text so the surrounding prose still reads naturally.
 */
export function extractSettingsLinkButtons(content: string): {
  processedContent: string;
  linkButtons: LinkButton[];
} {
  const linkButtons: LinkButton[] = [];

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

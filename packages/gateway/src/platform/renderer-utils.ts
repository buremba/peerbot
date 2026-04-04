/**
 * Shared renderer and markdown utilities.
 * Extracts common helpers duplicated across Telegram, WhatsApp, and Slack converters/renderers.
 */

/**
 * Chunk a long message into smaller parts, breaking at natural boundaries.
 */
export function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = maxLength;

    const newlineIndex = remaining.lastIndexOf("\n", maxLength);
    if (newlineIndex > maxLength * 0.5) {
      breakPoint = newlineIndex + 1;
    } else {
      const spaceIndex = remaining.lastIndexOf(" ", maxLength);
      if (spaceIndex > maxLength * 0.5) {
        breakPoint = spaceIndex + 1;
      }
    }

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

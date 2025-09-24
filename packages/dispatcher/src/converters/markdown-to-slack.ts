#!/usr/bin/env bun

import { marked } from "marked";

/**
 * Custom renderer for converting markdown to Slack's mrkdwn format
 */
class SlackRenderer extends marked.Renderer {
  heading(text: string, _level: number): string {
    // Convert headings - preserve inline formatting like bold/italic
    // Headers themselves are not automatically bold in Slack

    let processedText = text;

    // Convert markdown bold (**text**) to Slack bold (*text*)
    processedText = processedText.replace(/\*\*(.+?)\*\*/g, "*$1*");

    // Convert markdown bold (__text__) to Slack bold (*text*)
    processedText = processedText.replace(/__(.+?)__/g, "*$1*");

    // Convert markdown italic (*text*) to Slack italic (_text_)
    // But be careful not to convert Slack bold markers we just added
    processedText = processedText.replace(
      /(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g,
      "_$1_"
    );

    // Add extra spacing after headers for visual separation
    return `${processedText}\n\n`;
  }

  paragraph(text: string): string {
    return `${text}\n\n`;
  }

  strong(text: string): string {
    // Bold in Slack is *text*
    return `*${text}*`;
  }

  em(text: string): string {
    // Italic in Slack is _text_
    return `_${text}_`;
  }

  code(text: string): string {
    // Inline code in Slack is `text`
    return `\`${text}\``;
  }

  codespan(text: string): string {
    // Inline code in Slack is `text`
    return `\`${text}\``;
  }

  blockquote(quote: string): string {
    // Convert blockquote to italic with quote prefix
    const lines = quote.trim().split("\n");
    return `${lines.map((line) => `_> ${line.trim()}_`).join("\n")}\n\n`;
  }

  list(body: string, _ordered: boolean, _start: number | ""): string {
    return `${body}\n`;
  }

  listitem(text: string, _task?: boolean, _checked?: boolean): string {
    // Slack supports bullet points and numbered lists
    return `• ${text.trim()}\n`;
  }

  link(href: string, _title: string | null | undefined, text: string): string {
    // Slack link format is <url|text>
    return `<${href}|${text}>`;
  }

  br(): string {
    return "\n";
  }

  hr(): string {
    return "\n---\n\n";
  }
}

/**
 * Convert markdown to Slack's mrkdwn format using marked with custom renderer
 */
export function convertMarkdownToSlack(content: string): string {
  const renderer = new SlackRenderer();

  // First, handle raw triple backtick code blocks that might not be properly formatted
  // This handles cases where content has ```language\ncode\n``` format
  const preprocessed = content.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (match, lang, code) => {
      // Convert to a format that marked can handle properly
      if (code?.trim()) {
        // Use HTML pre/code tags that marked will process
        const langAttr = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${langAttr}>${code.trim()}</code></pre>`;
      }
      return match;
    }
  );

  // Configure marked options
  marked.setOptions({
    renderer: renderer,
    breaks: true, // Convert single line breaks to <br>
    gfm: true, // GitHub flavored markdown
  });

  try {
    let processed = marked.parse(preprocessed) as string;

    // Clean up extra whitespace but preserve intentional line breaks
    processed = processed
      .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
      .trim();

    // Handle code blocks specially - marked converts them to HTML, we need to convert back to Slack format
    // Note: Slack doesn't support triple backtick code blocks in text fields, only in blocks
    // So we'll convert code blocks to single-line code format for the text field
    processed = processed.replace(
      /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g,
      (_match, _language, code) => {
        // Decode HTML entities in code blocks
        const decodedCode = code
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

        // For Slack text field, use single backticks for inline code
        // For multi-line code, we'll use indentation instead of backticks
        // since Slack text fields don't support proper code blocks
        const lines = decodedCode.trim().split("\n");
        if (lines.length === 1) {
          return `\`${lines[0]}\``;
        } else {
          // For multi-line code, use indentation (4 spaces) instead of backticks
          // This preserves the code structure without causing issues with # symbols
          return lines.map((line: string) => `    ${line}`).join("\n");
        }
      }
    );

    // Clean up any remaining HTML entities that might have been introduced
    processed = processed
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return processed;
  } catch (error) {
    console.error("Failed to parse markdown:", error);
    // Fallback to original content if parsing fails
    return content;
  }
}
#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { convertMarkdownToSlack } from "./markdown-to-slack";
import { processCodeBlockWithAction, validateCodeContentLength, validateBlockkitContent } from "./code-block-handler";

// Generate deterministic action IDs based on content to prevent conflicts during rapid message updates - fixed
function generateDeterministicActionId(
  content: string,
  prefix: string = "action"
): string {
  const hash = createHash("sha256")
    .update(content)
    .digest("hex")
    .substring(0, 8);
  return `${prefix}_${hash}`;
}

export interface ProcessedMarkdown {
  text: string;
  blocks: any[];
}

/**
 * Enhanced markdown to Slack conversion with proper handling of all common markdown elements
 */
export function processMarkdownAndBlockkit(content: string): ProcessedMarkdown {
  // Process blockkit with metadata first
  const codeBlockRegex = /```(\w+)\s*\{([^}]+)\}\s*\n?([\s\S]*?)\n?```/g;
  let processedContent = content;
  const actionButtons: any[] = [];
  let blockIndex = 0; // Track position to ensure unique action_ids

  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: Required for regex matching pattern
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const [fullMatch, language, metadataStr, codeContent] = match;

    try {
      const { metadata, shouldHideBlock, shouldSkipButton } = processCodeBlockWithAction(
        language, 
        metadataStr, 
        codeContent
      );

      if (metadata.action) {
        // Hide the code block if needed
        if (shouldHideBlock) {
          processedContent = processedContent.replace(fullMatch, "");
        }

        // Skip the button entirely if needed
        if (shouldSkipButton) {
          console.log(
            `[DEBUG] Skipping ${language} action with show:false - action: ${metadata.action}`
          );
          continue;
        }

        if (language === "blockkit") {
          const validation = validateBlockkitContent(codeContent, metadata.action);
          if (!validation.isValid) {
            console.log(
              `[DEBUG] Skipping blockkit button - ${validation.reason}, action: ${metadata.action}`
            );
            continue;
          }

          const actionId = generateDeterministicActionId(
            codeContent + metadata.action + blockIndex,
            "blockkit_form"
          );
          const button = {
            type: "button",
            text: { type: "plain_text", text: metadata.action },
            action_id: actionId,
            value: validation.buttonValue,
          };
          actionButtons.push(button);
          console.log(
            `[DEBUG] Added blockkit button - action: ${metadata.action}, actionId: ${actionId}`
          );
        } else {
          // For non-blockkit actions (bash, python, etc.)
          if (codeContent) {
            const validation = validateCodeContentLength(codeContent, language, metadata.action);
            if (!validation.isValid) {
              console.log(
                `[DEBUG] Skipping ${language} button - ${validation.reason}, action: ${metadata.action}`
              );
              continue;
            }

            const actionId = generateDeterministicActionId(
              codeContent + metadata.action + blockIndex,
              language
            );
            const button = {
              type: "button",
              text: { type: "plain_text", text: metadata.action },
              action_id: `${language}_${actionId}`,
              value: codeContent,
            };
            actionButtons.push(button);
            console.log(
              `[DEBUG] Added ${language} button - action: ${metadata.action}, actionId: ${language}_${actionId}`
            );
          }
        }
      }

      blockIndex++; // Increment for each processed block to ensure unique action_ids
    } catch (error) {
      console.error("Failed to parse code block:", error);
    }
  }

  // Enhanced markdown to Slack conversion
  const text = convertMarkdownToSlack(processedContent);

  // Always create at least one block
  const blocks: any[] = [];

  if (text) {
    // Slack has a 3000 character limit for text in section blocks
    const MAX_TEXT_LENGTH = 3000;

    if (text.length <= MAX_TEXT_LENGTH) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: text,
        },
      });
    } else {
      // Split long text into multiple blocks
      let remainingText = text;
      while (remainingText.length > 0) {
        // Take up to MAX_TEXT_LENGTH characters, but try to break at a newline if possible
        let chunk = remainingText.substring(0, MAX_TEXT_LENGTH);

        // If we're not at the end and we're cutting mid-text, try to find a better break point
        if (remainingText.length > MAX_TEXT_LENGTH) {
          const lastNewline = chunk.lastIndexOf("\n");
          if (lastNewline > MAX_TEXT_LENGTH * 0.8) {
            // If there's a newline in the last 20% of the chunk
            chunk = chunk.substring(0, lastNewline);
          }
        }

        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunk,
          },
        });

        remainingText = remainingText.substring(chunk.length).trim();
      }
    }
  }

  if (actionButtons.length > 0) {
    console.log(
      `[DEBUG] Adding ${actionButtons.length} action buttons to blocks`
    );
    if (blocks.length > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: actionButtons,
    });
  }

  console.log(
    `[DEBUG] processMarkdownAndBlockkit returning - text length: ${text?.length || 0}, blocks count: ${blocks.length}, action buttons: ${actionButtons.length}`
  );

  return { text, blocks };
}

// Re-export the action ID generator for use in other modules
export { generateDeterministicActionId };
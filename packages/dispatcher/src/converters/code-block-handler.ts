#!/usr/bin/env bun

/**
 * Code block processing utilities for Slack message formatting
 * This module handles specific code block transformations and processing
 */

/**
 * Parse metadata from code block headers
 * Example: ```bash {action: "Run", show: true}
 */
export function parseCodeBlockMetadata(metadataStr: string): Record<string, any> {
  const metadata: any = {};
  
  metadataStr?.split(",").forEach((pair) => {
    const [key, value] = pair.split(":").map((s) => s.trim());
    if (key && value) {
      const cleanKey = key.replace(/"/g, "");
      let cleanValue: any = value.replace(/"/g, "");
      if (cleanValue === "true") cleanValue = true;
      if (cleanValue === "false") cleanValue = false;
      metadata[cleanKey] = cleanValue;
    }
  });

  return metadata;
}

/**
 * Process code blocks with action metadata
 */
export function processCodeBlockWithAction(
  language: string,
  metadataStr: string,
  codeContent: string
): {
  metadata: Record<string, any>;
  shouldHideBlock: boolean;
  shouldSkipButton: boolean;
} {
  const metadata = parseCodeBlockMetadata(metadataStr);
  
  let shouldHideBlock = false;
  let shouldSkipButton = false;

  if (metadata.action) {
    console.log(
      `[DEBUG] Found action block - language: ${language}, action: ${metadata.action}, show: ${metadata.show}`
    );

    if (language === "blockkit") {
      // Always hide the code block from the message for blockkit actions
      shouldHideBlock = true;
      // Skip entirely if show: false
      if (metadata.show === false) {
        shouldSkipButton = true;
      }
    } else {
      // For non-blockkit actions (bash, python, etc.)
      // Hide the code block unless show: true
      if (metadata.show !== true) {
        shouldHideBlock = true;
      }
      // Skip entirely if show: false (no button)
      if (metadata.show === false) {
        shouldSkipButton = true;
      }
    }
  }

  return { metadata, shouldHideBlock, shouldSkipButton };
}

/**
 * Validate code content against Slack limits
 */
export function validateCodeContentLength(
  codeContent: string,
  language: string,
  action?: string
): { isValid: boolean; reason?: string } {
  // Skip the button entirely if value exceeds 2000 chars (Slack limit)
  if (codeContent.length > 2000) {
    console.log(
      `[DEBUG] Skipping ${language} button - exceeds 2000 char limit (${codeContent.length} chars), action: ${action}`
    );
    return {
      isValid: false,
      reason: `exceeds 2000 char limit (${codeContent.length} chars)`
    };
  }
  
  return { isValid: true };
}

/**
 * Validate blockkit JSON content against Slack limits
 */
export function validateBlockkitContent(
  codeContent: string,
  action?: string
): { isValid: boolean; buttonValue?: string; reason?: string } {
  try {
    const parsed = codeContent ? JSON.parse(codeContent.trim()) : { blocks: [] };
    const buttonValue = JSON.stringify({
      blocks: parsed.blocks || [parsed],
    });

    // Skip the button entirely if value exceeds 2000 chars (Slack limit)
    if (buttonValue.length > 2000) {
      console.log(
        `[DEBUG] Skipping blockkit button - exceeds 2000 char limit (${buttonValue.length} chars), action: ${action}`
      );
      return {
        isValid: false,
        reason: `exceeds 2000 char limit (${buttonValue.length} chars)`
      };
    }

    return { isValid: true, buttonValue };
  } catch (error) {
    console.error("Failed to parse blockkit JSON:", error);
    return {
      isValid: false,
      reason: "invalid JSON format"
    };
  }
}
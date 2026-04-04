import { describe, expect, test } from "bun:test";
import { extractSettingsLinkButtons } from "../platform/link-buttons";

describe("extractSettingsLinkButtons", () => {
  test("extracts settings link and replaces with label", () => {
    const content =
      "Click [Open Settings](https://example.com/connect/claim?claim=abc123) to continue";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0]!.text).toBe("Open Settings");
    expect(linkButtons[0]!.url).toBe(
      "https://example.com/connect/claim?claim=abc123"
    );
    expect(processedContent).toBe("Click Open Settings to continue");
    expect(processedContent).not.toContain("https://");
  });

  test("extracts settings link with agent param", () => {
    const content =
      "[Settings](https://example.com/connect/claim?claim=abc&agent=agent-1)";
    const { linkButtons } = extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0]!.url).toBe(
      "https://example.com/connect/claim?claim=abc&agent=agent-1"
    );
  });

  test("extracts multiple settings links", () => {
    const content =
      "[First](https://a.com/connect/claim?claim=1) and [Second](https://b.com/connect/claim?claim=2)";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(2);
    expect(processedContent).toBe("First and Second");
  });

  test("filters out localhost URLs", () => {
    const content =
      "[Settings](http://localhost:3000/connect/claim?claim=token)";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(0);
    // Label still replaces the link
    expect(processedContent).toBe("Settings");
  });

  test("filters out 127.0.0.1 URLs", () => {
    const content = "[Settings](http://127.0.0.1/connect/claim?claim=token)";
    const { linkButtons } = extractSettingsLinkButtons(content);
    expect(linkButtons).toHaveLength(0);
  });

  test("does not match non-settings links", () => {
    const content = "[Home](https://example.com/home)";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(0);
    expect(processedContent).toBe(content); // unchanged
  });

  test("does not match links without claim= parameter", () => {
    const content = "[Settings](https://example.com/agent)";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(0);
    expect(processedContent).toBe(content);
  });

  test("returns empty buttons for content without links", () => {
    const content = "No links here, just plain text";
    const { processedContent, linkButtons } =
      extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(0);
    expect(processedContent).toBe(content);
  });

  test("handles HTTP and HTTPS", () => {
    const httpContent = "[A](http://example.com/connect/claim?claim=x)";
    const httpsContent = "[B](https://example.com/connect/claim?claim=y)";

    const httpResult = extractSettingsLinkButtons(httpContent);
    const httpsResult = extractSettingsLinkButtons(httpsContent);

    expect(httpResult.linkButtons).toHaveLength(1);
    expect(httpsResult.linkButtons).toHaveLength(1);
  });

  test("mixed localhost and remote links only keeps remote", () => {
    const content =
      "[Local](http://localhost/connect/claim?claim=a) and [Remote](https://app.com/connect/claim?claim=b)";
    const { linkButtons } = extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0]!.url).toContain("app.com");
  });

  test("keeps backward compatibility with legacy /agent claim links", () => {
    const content = "[Legacy](https://example.com/agent?claim=legacy)";
    const { linkButtons } = extractSettingsLinkButtons(content);

    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0]!.url).toBe("https://example.com/agent?claim=legacy");
  });
});

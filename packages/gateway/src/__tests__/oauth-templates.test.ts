import { describe, expect, test } from "bun:test";
import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../auth/oauth-templates";

describe("OAuth template escaping", () => {
  test("escapes reflected OAuth error params", () => {
    const html = renderOAuthErrorPage(
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert("xss")>'
    );

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('<img src=x onerror=alert("xss")>');
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
    expect(html).toContain("&lt;img src=x onerror=alert(&quot;xss&quot;)&gt;");
  });

  test("escapes provider name on success page", () => {
    const html = renderOAuthSuccessPage('"><svg onload=alert(1)>');

    expect(html).not.toContain('"><svg onload=alert(1)>');
    expect(html).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });
});

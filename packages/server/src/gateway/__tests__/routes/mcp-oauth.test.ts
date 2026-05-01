import { describe, expect, test } from "bun:test";
import { createMcpOAuthRoutes } from "../../routes/public/mcp-oauth.js";

describe("mcp oauth callback route", () => {
  test("escapes reflected error and error_description to prevent XSS", async () => {
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.com",
    });

    const maliciousError = '"><script>alert(1)</script>';
    const maliciousDescription = '<script>alert("xss")</script>';
    const url =
      "https://gateway.example.com/mcp/oauth/callback" +
      `?error=${encodeURIComponent(maliciousError)}` +
      `&error_description=${encodeURIComponent(maliciousDescription)}`;

    const res = await router.request(url);

    expect(res.status).toBe(400);
    const html = await res.text();

    expect(html).not.toContain(maliciousError);
    expect(html).not.toContain(maliciousDescription);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });
});

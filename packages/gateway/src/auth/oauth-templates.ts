/**
 * Format MCP ID into human-readable name
 * Example: "github-mcp" -> "Github Mcp"
 */
export function formatMcpName(mcpId: string): string {
  return mcpId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * HTML templates for OAuth flow
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "`":
        return "&#96;";
      default:
        return char;
    }
  });
}

export function renderOAuthSuccessPage(mcpName: string): string {
  const safeMcpName = escapeHtml(mcpName);

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 400px;
          }
          .success-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          h1 {
            color: #2d3748;
            margin: 0 0 1rem 0;
          }
          p {
            color: #718096;
            line-height: 1.6;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✅</div>
          <h1>Connected!</h1>
          <p>Successfully authenticated with <strong>${safeMcpName}</strong></p>
          <p>You can now close this window and return to the app.</p>
        </div>
      </body>
    </html>
  `;
}

export function renderOAuthErrorPage(
  error: string,
  description?: string
): string {
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(
    description || "An error occurred during authentication"
  );

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Authentication Failed</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 400px;
          }
          .error-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          h1 {
            color: #2d3748;
            margin: 0 0 1rem 0;
          }
          p {
            color: #718096;
            line-height: 1.6;
          }
          .error-code {
            background: #f7fafc;
            padding: 0.5rem;
            border-radius: 6px;
            font-family: monospace;
            font-size: 0.875rem;
            color: #e53e3e;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">❌</div>
          <h1>Authentication Failed</h1>
          <p>${safeDescription}</p>
          <div class="error-code">${safeError}</div>
          <p style="margin-top: 2rem;">Please close this window and try again.</p>
        </div>
      </body>
    </html>
  `;
}

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

/**
 * Render a success page that auto-closes the tab (for in-app browsers)
 * and provides a fallback link to agent configuration when available.
 */
export function renderOAuthSuccessPage(
  name: string,
  settingsUrl?: string,
  options?: {
    title?: string;
    description?: string;
    details?: string;
    closeNote?: string;
  }
): string {
  const safeName = escapeHtml(name);
  const safeSettingsUrl = settingsUrl ? escapeHtml(settingsUrl) : "";
  const safeTitle = escapeHtml(options?.title || "Connected!");
  const safeDescription = escapeHtml(
    options?.description || `Successfully authenticated with ${name}`
  );
  const safeDetails = options?.details ? escapeHtml(options.details) : "";
  const safeCloseNote = escapeHtml(
    options?.closeNote || "You can close this tab and return to your chat."
  );

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Connected</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #334155 0%, #0f172a 100%);
          }
          .container {
            background: white;
            padding: 2.5rem;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 360px;
          }
          .icon { font-size: 3rem; margin-bottom: 0.75rem; }
          h1 { color: #2d3748; margin: 0 0 0.5rem 0; font-size: 1.25rem; }
          p { color: #718096; line-height: 1.5; font-size: 0.875rem; margin: 0 0 1rem 0; }
          .btn {
            display: inline-block;
            padding: 0.625rem 1.25rem;
            background: linear-gradient(to right, #334155, #1e293b);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 0.875rem;
            font-weight: 600;
          }
          .btn:hover { opacity: 0.9; }
          .close-note { color: #94a3b8; font-size: 0.75rem; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">&#9989;</div>
          <h1>${safeTitle}</h1>
          <p>${safeDescription.includes(safeName) ? safeDescription : `${safeDescription} <strong>${safeName}</strong>`}</p>
          ${safeDetails ? `<p>${safeDetails}</p>` : ""}
          ${safeSettingsUrl ? `<a class="btn" href="${safeSettingsUrl}">Open Configuration</a>` : ""}
          <p class="close-note">${safeCloseNote}</p>
        </div>
        <script>
          // Auto-close for Telegram in-app browser
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.close();
          }
          // Try to close the window/tab after a brief moment
          setTimeout(function() { window.close(); }, 1500);
        </script>
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

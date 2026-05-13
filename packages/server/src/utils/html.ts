/**
 * HTML escaping helper shared across server-rendered pages and OAuth templates.
 */
export function escapeHtml(value: string): string {
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

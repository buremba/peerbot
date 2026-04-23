export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const FOOTER_HTML = `<p style="margin-top:32px;color:#888;font-size:12px;line-height:1.5">Lobu · <a href="https://lobu.ai" style="color:#888">lobu.ai</a><br>You received this because someone used this address on Lobu. If that wasn't you, you can safely ignore this email.</p>`;

export const FOOTER_TEXT = `\n\n--\nLobu · https://lobu.ai\nYou received this because someone used this address on Lobu. If that wasn't you, you can safely ignore this email.`;

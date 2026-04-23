import { escapeHtml, FOOTER_HTML, FOOTER_TEXT } from './shared';

export function magicLinkTemplate(opts: { url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const url = escapeHtml(opts.url);
  return {
    subject: 'Your Lobu sign-in link',
    html: `<p>Click the link below to sign in to Lobu:</p><p><a href="${url}">Sign in to Lobu</a></p><p>This link expires in 15 minutes. If you didn't request it, you can ignore this message.</p>${FOOTER_HTML}`,
    text: `Sign in to Lobu: ${opts.url}\n\nThis link expires in 15 minutes. If you didn't request it, you can ignore this message.${FOOTER_TEXT}`,
  };
}

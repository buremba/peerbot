import { escapeHtml, FOOTER_HTML, FOOTER_TEXT } from './shared';

export function passwordResetTemplate(opts: { url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const url = escapeHtml(opts.url);
  return {
    subject: 'Reset your Lobu password',
    html: `<p>We received a request to reset your Lobu password.</p><p><a href="${url}">Reset your password</a></p><p>This link expires in 1 hour. If you didn't request a password reset, you can ignore this message.</p>${FOOTER_HTML}`,
    text: `Reset your Lobu password: ${opts.url}\n\nThis link expires in 1 hour. If you didn't request a password reset, you can ignore this message.${FOOTER_TEXT}`,
  };
}

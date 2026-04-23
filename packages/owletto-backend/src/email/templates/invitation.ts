import { escapeHtml, FOOTER_HTML, FOOTER_TEXT } from './shared';

export function invitationTemplate(opts: {
  inviterName: string | null | undefined;
  orgName: string;
  acceptUrl: string;
}): {
  subject: string;
  html: string;
  text: string;
} {
  const inviter = opts.inviterName?.trim();
  const orgName = escapeHtml(opts.orgName);
  const acceptUrl = escapeHtml(opts.acceptUrl);
  const subject = inviter
    ? `${inviter} invited you to ${opts.orgName} on Lobu`
    : `You've been invited to ${opts.orgName} on Lobu`;
  const inviterLabel = inviter ? escapeHtml(inviter) : 'Someone';
  return {
    subject,
    html: `<p>${inviterLabel} invited you to join <strong>${orgName}</strong> on Lobu.</p><p><a href="${acceptUrl}">Accept invitation</a></p><p>This invitation expires in 48 hours.</p>${FOOTER_HTML}`,
    text: `${inviter ?? 'Someone'} invited you to join ${opts.orgName} on Lobu.\n\nAccept invitation: ${opts.acceptUrl}\n\nThis invitation expires in 48 hours.${FOOTER_TEXT}`,
  };
}

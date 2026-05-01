import { BrandedEmail } from './BrandedEmail';

export interface InvitationProps {
  inviterName?: string | null;
  orgName: string;
  acceptUrl: string;
}

export function InvitationEmail({ inviterName, orgName, acceptUrl }: InvitationProps) {
  const inviter = inviterName?.trim();
  const intro = inviter
    ? `${inviter} invited you to join ${orgName} on Lobu. This invitation expires in 48 hours.`
    : `You've been invited to join ${orgName} on Lobu. This invitation expires in 48 hours.`;

  return (
    <BrandedEmail
      preview={`Join ${orgName} on Lobu`}
      heading={`Join ${orgName}`}
      intro={intro}
      cta={{ href: acceptUrl, label: 'Accept invitation' }}
    />
  );
}

export function invitationSubject(opts: { inviterName?: string | null; orgName: string }): string {
  const inviter = opts.inviterName?.trim();
  return inviter
    ? `${inviter} invited you to ${opts.orgName} on Lobu`
    : `You've been invited to ${opts.orgName} on Lobu`;
}

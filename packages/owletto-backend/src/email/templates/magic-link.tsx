import { BrandedEmail } from './BrandedEmail';

export interface MagicLinkProps {
  url: string;
}

export function MagicLinkEmail({ url }: MagicLinkProps) {
  return (
    <BrandedEmail
      preview="Your sign-in link for Lobu"
      heading="Sign in to Lobu"
      intro="Click the button below to finish signing in. This link expires in 15 minutes."
      cta={{ href: url, label: 'Sign in' }}
      footerNote="If you didn't request this, you can safely ignore this email."
    />
  );
}

export const magicLinkSubject = 'Your Lobu sign-in link';

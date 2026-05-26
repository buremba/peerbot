import { BrandedEmail } from './BrandedEmail';

export interface MagicLinkProps {
  url: string;
  /**
   * 'sign-in' (default) is a normal login link. 'authorize' is used when an
   * application/agent is requesting access on the user's behalf — the copy must
   * make clear this is an authorization request, not a routine sign-in, so the
   * user doesn't grant third-party access thinking they're just logging in.
   */
  mode?: 'sign-in' | 'authorize';
}

export function MagicLinkEmail({ url, mode = 'sign-in' }: MagicLinkProps) {
  if (mode === 'authorize') {
    return (
      <BrandedEmail
        preview="An application is requesting access to your Lobu account"
        heading="Authorize access to Lobu"
        intro="An application is requesting access to your Lobu account. Click below to review the request — you'll see what it can access before you approve. This link expires in 15 minutes."
        cta={{ href: url, label: 'Review request' }}
        footerNote="If you didn't request this, you can safely ignore this email — no access is granted unless you approve."
      />
    );
  }
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
export const authorizeAppSubject = 'Authorize access to your Lobu account';

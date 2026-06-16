import { BrandedEmail } from './BrandedEmail';

interface WelcomeProps {
  name?: string | null;
  appUrl: string;
}

export function WelcomeEmail({ name, appUrl }: WelcomeProps) {
  const trimmedName = name?.trim();
  const greeting = trimmedName ? `Welcome to Lobu, ${trimmedName}` : 'Welcome to Lobu';

  return (
    <BrandedEmail
      preview="Welcome to Lobu"
      heading={greeting}
      intro="Your account is ready. Lobu helps your team turn messages, tools, and knowledge into AI agents that remember the context that matters."
      cta={{ href: appUrl, label: 'Open Lobu' }}
      afterCta="Start by creating an agent or connecting the apps where your work already happens."
      footerNote="If you didn't create this account, you can safely ignore this email."
    />
  );
}

export const welcomeSubject = 'Welcome to Lobu';

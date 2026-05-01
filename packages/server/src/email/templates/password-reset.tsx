import { BrandedEmail } from './BrandedEmail';

export interface PasswordResetProps {
  url: string;
}

export function PasswordResetEmail({ url }: PasswordResetProps) {
  return (
    <BrandedEmail
      preview="Reset your Lobu password"
      heading="Reset your password"
      intro="We received a request to reset your Lobu password. Click the button below to choose a new one. This link expires in 1 hour."
      cta={{ href: url, label: 'Reset password' }}
      footerNote="If you didn't request a password reset, you can safely ignore this email."
    />
  );
}

export const passwordResetSubject = 'Reset your Lobu password';

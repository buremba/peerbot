import { render } from '@react-email/render';
import type { Env } from '@lobu/connector-sdk';
import type { ReactElement } from 'react';
import { Resend } from 'resend';

export type EmailCategory = 'auth' | 'invite';

export interface TransactionalEmailInput {
  env: Env;
  to: string;
  subject: string;
  react: ReactElement;
  category: EmailCategory;
  /** Overrides the default From address for this category. */
  fromOverride?: string;
}

export interface TransactionalEmailResult {
  id: string | null;
}

const DEV_FALLBACK_FROM: Record<EmailCategory, string> = {
  auth: 'Lobu <onboarding@resend.dev>',
  invite: 'Lobu <onboarding@resend.dev>',
};

function resolveFrom(env: Env, category: EmailCategory, override?: string): string | null {
  if (override) return override;
  const configured = category === 'auth' ? env.EMAIL_FROM_AUTH : env.EMAIL_FROM_INVITES;
  if (configured) return configured;
  const runtimeNodeEnv = env.NODE_ENV || process.env.NODE_ENV || 'development';
  if (runtimeNodeEnv !== 'production') return DEV_FALLBACK_FROM[category];
  return null;
}

/**
 * Send a transactional email via Resend with deliverability best practices:
 *  - React Email component rendered to multipart html + plain-text body
 *  - List-Unsubscribe + List-Unsubscribe-Post (one-click) when EMAIL_UNSUBSCRIBE is set
 *  - Reply-To pointing at a monitored inbox
 *  - Category tag for per-flow deliverability metrics
 */
export async function sendTransactionalEmail(
  input: TransactionalEmailInput
): Promise<TransactionalEmailResult> {
  const { env, to, subject, react, category, fromOverride } = input;

  if (!env.RESEND_API_KEY) {
    throw new Error(`Email delivery is not configured (RESEND_API_KEY missing) for ${category}.`);
  }

  const from = resolveFrom(env, category, fromOverride);
  if (!from) {
    const requiredVar = category === 'auth' ? 'EMAIL_FROM_AUTH' : 'EMAIL_FROM_INVITES';
    throw new Error(`${requiredVar} is required for ${category} email delivery in production.`);
  }

  const [html, text] = await Promise.all([render(react), render(react, { plainText: true })]);

  const headers: Record<string, string> = {};
  if (env.EMAIL_UNSUBSCRIBE) {
    const value = env.EMAIL_UNSUBSCRIBE.startsWith('<')
      ? env.EMAIL_UNSUBSCRIBE
      : `<${env.EMAIL_UNSUBSCRIBE}>`;
    headers['List-Unsubscribe'] = value;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    text,
    ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    tags: [{ name: 'category', value: category }],
  });

  if (error) {
    console.error(
      { to, from, category, error },
      '[Email] Resend failed to deliver transactional email'
    );
    throw new Error(error.message || `${category} email delivery failed.`);
  }

  console.info(
    { to, from, category, emailId: data?.id ?? null },
    '[Email] Transactional email queued'
  );
  return { id: data?.id ?? null };
}

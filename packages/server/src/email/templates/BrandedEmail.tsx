import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

export interface BrandedEmailProps {
  preview: string;
  heading: string;
  intro: string;
  cta?: { href: string; label: string };
  afterCta?: ReactNode;
  footerNote?: string;
}

/**
 * Shared layout for transactional Lobu emails.
 * Designed to render correctly in Gmail, Apple Mail, and Outlook (incl. desktop).
 * Uses inline styles — external CSS is stripped by most clients.
 */
export function BrandedEmail({
  preview,
  heading,
  intro,
  cta,
  afterCta,
  footerNote,
}: BrandedEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Text style={wordmark}>Lobu</Text>
          </Section>

          <Section style={card}>
            <Text style={h1}>{heading}</Text>
            <Text style={paragraph}>{intro}</Text>
            {cta ? (
              <Section style={buttonWrapper}>
                <Button href={cta.href} style={button}>
                  {cta.label}
                </Button>
              </Section>
            ) : null}
            {afterCta ? <Text style={paragraph}>{afterCta}</Text> : null}
            {footerNote ? <Text style={muted}>{footerNote}</Text> : null}
          </Section>

          <Hr style={hr} />
          <Section>
            <Text style={footer}>
              Lobu ·{' '}
              <Link href="https://lobu.ai" style={footerLink}>
                lobu.ai
              </Link>
            </Text>
            <Text style={footerSmall}>
              You're receiving this because someone used this address on Lobu. If that wasn't you,
              you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body: CSSProperties = {
  backgroundColor: '#f5f5f7',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  margin: 0,
  padding: '32px 0',
};

const container: CSSProperties = {
  margin: '0 auto',
  maxWidth: 560,
  padding: '0 16px',
};

const header: CSSProperties = {
  padding: '0 8px 16px',
};

const wordmark: CSSProperties = {
  color: '#0a0a0a',
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: '-0.01em',
  margin: 0,
};

const card: CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e5e5',
  borderRadius: 12,
  padding: '32px 28px',
};

const h1: CSSProperties = {
  color: '#0a0a0a',
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  lineHeight: '1.3',
  margin: '0 0 16px',
};

const paragraph: CSSProperties = {
  color: '#333333',
  fontSize: 15,
  lineHeight: '1.6',
  margin: '0 0 20px',
};

const muted: CSSProperties = {
  color: '#6b7280',
  fontSize: 13,
  lineHeight: '1.5',
  margin: '16px 0 0',
};

const buttonWrapper: CSSProperties = {
  margin: '24px 0',
};

const button: CSSProperties = {
  backgroundColor: '#0a0a0a',
  borderRadius: 8,
  color: '#ffffff',
  display: 'inline-block',
  fontSize: 15,
  fontWeight: 600,
  padding: '12px 24px',
  textDecoration: 'none',
};

const hr: CSSProperties = {
  borderColor: '#e5e5e5',
  margin: '32px 0 16px',
};

const footer: CSSProperties = {
  color: '#6b7280',
  fontSize: 13,
  margin: '0 0 4px',
  padding: '0 8px',
};

const footerLink: CSSProperties = {
  color: '#6b7280',
  textDecoration: 'underline',
};

const footerSmall: CSSProperties = {
  color: '#9ca3af',
  fontSize: 12,
  lineHeight: '1.5',
  margin: 0,
  padding: '0 8px',
};

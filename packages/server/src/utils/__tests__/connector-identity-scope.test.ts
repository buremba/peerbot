import { describe, expect, it } from 'vitest';
import { validateConnectorMetadata } from '../connector-compiler';

function metadata(feeds: Record<string, unknown>) {
  return {
    key: 'erp',
    name: 'ERP',
    version: '1.0.0',
    authSchema: null,
    webhook: null,
    feeds,
    actions: null,
    automationEvents: null,
    optionsSchema: null,
  };
}

function identity(namespace: string, eventPath: string, extra: Record<string, unknown> = {}) {
  return { namespace, eventPath, ...extra };
}

function feed(eventKind: string, declarations: unknown[]) {
  return {
    eventKinds: {
      [eventKind]: {
        attributions: declarations.map((declaration) => ({
          role: 'about',
          target: { identities: [declaration] },
        })),
      },
    },
  };
}

describe('connector identity scope manifest validation', () => {
  it('requires scopeKeyPath exactly for tenant scope', () => {
    expect(() =>
      validateConnectorMetadata(
        metadata({ customers: feed('customer.created', [identity('erp_customer', 'metadata.id', { scope: 'tenant' })]) })
      )
    ).toThrow(/erp_customer.*scopeKeyPath.*tenant/i);

    expect(() =>
      validateConnectorMetadata(
        metadata({ customers: feed('customer.created', [identity('erp_customer', 'metadata.id', { scopeKeyPath: 'metadata.tenant_id' })]) })
      )
    ).toThrow(/erp_customer.*scopeKeyPath.*organization/i);
  });

  it('rejects unsupported identity scope vocabulary', () => {
    expect(() =>
      validateConnectorMetadata(
        metadata({ customers: feed('customer.created', [identity('erp_customer', 'metadata.id', { scope: 'workspace' })]) })
      )
    ).toThrow(/erp_customer.*workspace.*organization.*tenant/i);
  });

  it('rejects NUL in identity namespaces and tenant scope paths', () => {
    expect(() =>
      validateConnectorMetadata(
        metadata({
          customers: feed('customer.created', [
            identity('erp\0customer', 'metadata.id'),
          ]),
        })
      )
    ).toThrow(/identity namespace.*must not contain NUL/i);

    expect(() =>
      validateConnectorMetadata(
        metadata({
          customers: feed('customer.created', [
            identity('erp_customer', 'metadata.id', {
              scope: 'tenant',
              scopeKeyPath: 'metadata.tenant\0id',
            }),
          ]),
        })
      )
    ).toThrow(/scopeKeyPath.*must not contain NUL/i);
  });

  it('names both declarations when one namespace has conflicting shapes', () => {
    expect(() =>
      validateConnectorMetadata(
        metadata({
          customers: feed('customer.created', [identity('erp_customer', 'metadata.id')]),
          invoices: feed('invoice.created', [
            identity('erp_customer', 'metadata.customer_id', {
              scope: 'tenant',
              scopeKeyPath: 'metadata.tenant_id',
            }),
          ]),
        })
      )
    ).toThrow(/erp_customer.*customer\.created.*invoice\.created/i);
  });

  it('keeps scopeKeyPath exact across event kinds within one connector', () => {
    expect(() =>
      validateConnectorMetadata(
        metadata({
          customers: feed('customer.created', [
            identity('erp_customer', 'metadata.id', {
              scope: 'tenant',
              scopeKeyPath: 'metadata.tenant_id',
            }),
          ]),
          invoices: feed('invoice.created', [
            identity('erp_customer', 'metadata.customer_id', {
              scope: 'tenant',
              scopeKeyPath: 'metadata.account_id',
            }),
          ]),
        })
      )
    ).toThrow(/erp_customer.*customer\.created.*invoice\.created/i);
  });
});

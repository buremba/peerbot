import { describe, expect, it } from 'vitest';
import { SCOPED_IDENTITY_ALIASES_METADATA_KEY } from '../../identity/scope-projection';
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

  it('rejects traits that target server-owned identity projections', () => {
    const connector = metadata({
      customers: {
        eventKinds: {
          'customer.created': {
            attributions: [
              {
                role: 'about',
                target: {
                  identities: [identity('erp_customer', 'metadata.id')],
                },
                traits: {
                  [SCOPED_IDENTITY_ALIASES_METADATA_KEY]: {
                    eventPath: 'metadata.forged_aliases',
                    mergeStrategy: 'overwrite',
                  },
                },
              },
            ],
          },
        },
      },
    });

    expect(() => validateConnectorMetadata(connector)).toThrow(
      /trait.*reserved for server-authored identity scope projections/i
    );
  });
});

import { describe, expect, test } from 'vitest';
import {
  type ConnectorMetadata,
  validateConnectorMetadata,
} from '../connector-compiler';

function metadataWithEventKind(eventKind: Record<string, unknown>): ConnectorMetadata {
  return {
    key: 'relationship-declaration-probe',
    name: 'Relationship Declaration Probe',
    version: '1.0.0',
    authSchema: null,
    webhook: null,
    feeds: {
      invoices: {
        key: 'invoices',
        name: 'Invoices',
        eventKinds: { invoice: eventKind },
      },
    },
    actions: null,
    automationEvents: null,
    optionsSchema: null,
  };
}

const invoiceAttribution = {
  name: 'invoice',
  role: 'belongs_to',
  target: {
    entityType: 'invoice',
    identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.invoice_id' }],
  },
};

const customerAttribution = {
  name: 'customer',
  role: 'about',
  target: {
    entityType: 'customer',
    identities: [{ namespace: 'erp_customer', eventPath: 'metadata.customer_id' }],
  },
};

describe('connector relationship declaration validation', () => {
  test('keeps existing unnamed attributions valid when no relationships are declared', () => {
    const metadata = metadataWithEventKind({
      attributions: [{ role: 'about', target: { entityType: 'invoice' } }],
    });
    expect(() => validateConnectorMetadata(metadata)).not.toThrow();
  });

  test('accepts named attributions referenced by one relationship', () => {
    const metadata = metadataWithEventKind({
      attributions: [invoiceAttribution, customerAttribution],
      relationships: [{ type: 'invoice_customer', from: 'invoice', to: 'customer' }],
    });
    expect(() => validateConnectorMetadata(metadata)).not.toThrow();
  });

  test('rejects empty attribution names with event-kind context', () => {
    const metadata = metadataWithEventKind({
      attributions: [{ ...invoiceAttribution, name: '   ' }],
    });
    expect(() => validateConnectorMetadata(metadata)).toThrow(
      /feed 'invoices'.*event kind 'invoice'.*attribution name.*non-empty/i
    );
  });

  test('rejects duplicate attribution names within one event kind', () => {
    const metadata = metadataWithEventKind({
      attributions: [invoiceAttribution, { ...customerAttribution, name: 'invoice' }],
    });
    expect(() => validateConnectorMetadata(metadata)).toThrow(
      /event kind 'invoice'.*duplicate attribution name 'invoice'/i
    );
  });

  test.each(['from', 'to'] as const)('rejects an unknown %s reference by name', (side) => {
    const relationship = {
      type: 'invoice_customer',
      from: 'invoice',
      to: 'customer',
      [side]: 'missing',
    };
    const metadata = metadataWithEventKind({
      attributions: [invoiceAttribution, customerAttribution],
      relationships: [relationship],
    });
    expect(() => validateConnectorMetadata(metadata)).toThrow(
      new RegExp(`event kind 'invoice'.*${side} reference 'missing'.*named attribution`, 'i')
    );
  });

  test('rejects duplicate relationship declarations', () => {
    const relationship = { type: 'invoice_customer', from: 'invoice', to: 'customer' };
    const metadata = metadataWithEventKind({
      attributions: [invoiceAttribution, customerAttribution],
      relationships: [relationship, { ...relationship }],
    });
    expect(() => validateConnectorMetadata(metadata)).toThrow(
      /event kind 'invoice'.*duplicate relationship.*invoice_customer/i
    );
  });

  test.each(['type', 'from', 'to'] as const)('rejects an empty relationship %s', (field) => {
    const relationship = {
      type: 'invoice_customer',
      from: 'invoice',
      to: 'customer',
      [field]: '  ',
    };
    const metadata = metadataWithEventKind({
      attributions: [invoiceAttribution, customerAttribution],
      relationships: [relationship],
    });
    expect(() => validateConnectorMetadata(metadata)).toThrow(
      new RegExp(`event kind 'invoice'.*relationship ${field}.*non-empty`, 'i')
    );
  });
});

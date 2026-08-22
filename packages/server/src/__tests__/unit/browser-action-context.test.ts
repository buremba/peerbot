import { describe, expect, it } from 'vitest';
import { deriveBrowserActionContext } from '../../worker-api/browser-action-context';
import type { ToolContext } from '../../tools/registry';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: 'org_browser_context',
    userId: 'user_browser_context',
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'session',
    ...overrides,
  } as ToolContext;
}

describe('deriveBrowserActionContext', () => {
  it('prioritizes the acting Automation execution', () => {
    expect(
      deriveBrowserActionContext(
        context({
          actingAutomationId: 7,
          actingRunId: 42,
          sourceContext: { platform: 'slack', conversationId: 'thread-raw' },
          mcpConversationId: 'mcp-raw',
          mcpSessionId: 'mcp-session-raw',
        })
      )
    ).toEqual({
      id: 'automation:42',
      title: 'Owletto · Automation 7 · Run 42',
      flow_id: '42',
      kind: 'automation',
    });
  });

  it('derives a stable opaque context from a verified source conversation', () => {
    const first = deriveBrowserActionContext(
      context({
        sourceContext: {
          platform: 'slack',
          connectionId: 'slack-main',
          conversationId: 'C123:thread:1712345.678',
        },
      })
    );
    const second = deriveBrowserActionContext(
      context({
        sourceContext: {
          platform: 'slack',
          connectionId: 'slack-main',
          conversationId: 'C123:thread:1712345.678',
        },
      })
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'conversation' });
    expect(first?.id).toMatch(/^conversation:[a-f0-9]{12}$/);
    expect(first?.flow_id).toBe(first?.id);
    expect(JSON.stringify(first)).not.toContain('C123:thread:1712345.678');
  });

  it('uses host MCP conversation correlation before transport session fallback', () => {
    const rawHostConversationId = 'host-conversation-super-secret';
    const fromHostA = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpConversationId: rawHostConversationId,
        mcpSessionId: 'transport-a',
      })
    );
    const fromHostB = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpConversationId: rawHostConversationId,
        mcpSessionId: 'transport-b',
      })
    );
    const fromTransport = deriveBrowserActionContext(
      context({
        tokenType: 'oauth',
        clientId: 'chatgpt',
        mcpSessionId: 'transport-a',
      })
    );

    expect(fromHostA).toEqual(fromHostB);
    expect(fromHostA).toMatchObject({ kind: 'mcp' });
    expect(fromHostA?.id).not.toBe(fromTransport?.id);
    expect(JSON.stringify(fromHostA)).not.toContain(rawHostConversationId);
    expect(fromHostA?.title).not.toContain(rawHostConversationId);
  });
});

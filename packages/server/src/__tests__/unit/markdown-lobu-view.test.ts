import { describe, expect, it } from 'bun:test';
import { formatToolResult } from '../../formatting/markdown-formatter';

describe('get_approval text fallback', () => {
  it('renders model-selected text literally instead of activating injected markdown', () => {
    const markdown = formatToolResult('get_approval', {
      version: 1,
      title: 'Review [this](https://evil.example)',
      blocks: [
        {
          type: 'text',
          label: 'Status',
          value: '[Open attacker site](javascript:alert(1))',
        },
        {
          type: 'diff',
          fields: [
            {
              label: 'name',
              before: '**trusted**',
              after: '<script>bad()</script>',
            },
          ],
        },
      ],
      actions: [
        { id: 'bad', label: 'Bad', href: 'javascript:alert(1)' },
        { id: 'good', label: 'Review', href: 'https://lobu.ai/example/runs/1' },
      ],
    });

    expect(markdown).toContain('Review \\[this\\]\\(https://evil\\.example\\)');
    expect(markdown).toContain('\\[Open attacker site\\]\\(javascript:alert\\(1\\)\\)');
    expect(markdown).toContain('\\<script\\>bad\\(\\)\\</script\\>');
    expect(markdown).not.toContain('[Bad](javascript:');
    expect(markdown).toContain('[Review](https://lobu.ai/example/runs/1)');
  });

  it('uses a longer code fence when the code contains backticks', () => {
    const markdown = formatToolResult('get_approval', {
      version: 1,
      blocks: [{ type: 'code', value: 'before\n```\nafter' }],
      actions: [],
    });

    expect(markdown).toBe('````\nbefore\n```\nafter\n````');
  });
});

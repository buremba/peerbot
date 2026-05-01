/**
 * Markdown Formatter Tests
 */

import { describe, expect, it } from 'vitest';
import { formatToolResult } from '../markdown-formatter';

describe('formatToolResult', () => {
  describe('search tool', () => {
    it('should format search result with entity', () => {
      const result = {
        entity: {
          id: 1,
          name: 'TestBrand',
          parent_id: null,
          match_reason: 'name_match',
          match_score: 0.95,
          metadata: { domain: 'test.com' },
          stats: {
            content_count: 10,
            connection_count: 2,
            active_connection_count: 1,
            children_count: 3,
          },
        },
        matches: [
          {
            id: 1,
            name: 'TestBrand',
            parent_id: null,
            match_reason: 'name_match',
            match_score: 0.95,
            metadata: { domain: 'test.com' },
            stats: {
              content_count: 10,
              connection_count: 2,
              active_connection_count: 1,
              children_count: 3,
            },
          },
        ],
      };
      const md = formatToolResult('search_knowledge', result);
      expect(md).toContain('Search Results');
      expect(md).toContain('Entity ID');
    });

    it('should format empty search result', () => {
      const result = { entity: null, matches: [] };
      const md = formatToolResult('search_knowledge', result);
      expect(md).toContain('No Results Found');
    });
  });

  describe('query_sql tool', () => {
    it('should format SQL results as CSV', () => {
      const result = {
        rows: [
          { id: 1, name: 'Brand A' },
          { id: 2, name: 'Brand B' },
        ],
        row_count: 2,
        execution_time_ms: 15,
      };
      const md = formatToolResult('query_sql', result);
      expect(md).toContain('SQL Query Results');
      expect(md).toContain('Brand A');
      expect(md).toContain('Brand B');
      expect(md).toContain('csv');
    });

    it('should handle empty SQL result', () => {
      const result = { rows: [], row_count: 0, execution_time_ms: 5 };
      const md = formatToolResult('query_sql', result);
      expect(md).toContain('0');
    });
  });

  describe('get_watcher tool', () => {
    it('should format watcher windows', () => {
      const result = {
        windows: [
          {
            watcher_name: 'Sentiment',
            window_start: '2025-01-01T00:00:00Z',
            window_end: '2025-01-07T00:00:00Z',
            granularity: 'weekly',
            content_analyzed: 50,
            model_used: 'test-model',
            execution_time_ms: 100,
            extracted_data: { summary: 'Mostly positive' },
          },
        ],
      };
      const md = formatToolResult('get_watcher', result);
      expect(md).toContain('Watcher Windows');
      expect(md).toContain('Sentiment');
      expect(md).toContain('weekly');
    });

    it('should format no watchers available', () => {
      const result = { windows: [] };
      const md = formatToolResult('get_watcher', result);
      expect(md).toContain('No Watchers Available');
    });
  });

  describe('manage_watchers tool', () => {
    it('should format create result', () => {
      const result = {
        action: 'create',
        watcher_id: 42,
        template_version: 1,
        status: 'active',
      };
      const md = formatToolResult('manage_watchers', result);
      expect(md).toContain('Watcher Management');
      expect(md).toContain('42');
    });

    it('should format list result', () => {
      const result = {
        watchers: [
          {
            watcher_id: 1,
            template_slug: 'sentiment',
            status: 'active',
            entity_name: 'Acme',
            entity_type: 'topic',
            template_version: 1,
          },
        ],
      };
      const md = formatToolResult('list_watchers', result);
      expect(md).toContain('Watchers (1)');
    });

    it('should format template list result', () => {
      const result = {
        action: 'list',
        templates: [
          {
            template_id: '25',
            slug: 'reddit-opportunity-finder',
            name: 'Reddit Opportunity Finder',
            current_version: 1,
            watchers_count: 0,
          },
        ],
      };
      const md = formatToolResult('manage_watchers', result);
      expect(md).toContain('Templates (1)');
      expect(md).toContain('reddit-opportunity-finder');
    });

    it('should format template create result', () => {
      const result = {
        action: 'create',
        template_id: '25',
        slug: 'reddit-opportunity-finder',
        version: 1,
      };
      const md = formatToolResult('manage_watchers', result);
      expect(md).toContain('New Template Created');
      expect(md).toContain('reddit-opportunity-finder');
    });
  });

  describe('read_knowledge tool', () => {
    it('should format content result', () => {
      const result = {
        content: [
          {
            id: 1,
            platform: 'reddit',
            author_name: 'user1',
            title: 'Great insights',
            text_content: 'Really love it',
            occurred_at: '2025-01-01T00:00:00Z',
            score: 75.5,
          },
        ],
        total: 1,
        page: { offset: 0, limit: 50, has_more: false },
      };
      const md = formatToolResult('read_knowledge', result);
      expect(md).toContain('Content');
    });

    it('should format empty content', () => {
      const result = { content: [], total: 0, page: { offset: 0, limit: 50, has_more: false } };
      const md = formatToolResult('read_knowledge', result);
      expect(md).toContain('0 total');
    });
  });

  describe('unknown tool', () => {
    it('should fallback to JSON for unknown tools', () => {
      const result = { foo: 'bar' };
      const md = formatToolResult('unknown_tool', result);
      expect(md).toContain('json');
      expect(md).toContain('"foo"');
    });
  });

  describe('options', () => {
    it('should include raw JSON when requested', () => {
      const result = { rows: [], row_count: 0, execution_time_ms: 5 };
      const md = formatToolResult('query_sql', result, { includeRawJson: true });
      expect(md).toContain('Raw JSON');
    });
  });
});

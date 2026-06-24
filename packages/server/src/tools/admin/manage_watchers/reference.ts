/**
 * get_component_reference action handler for manage_watchers.
 * Returns static documentation about available watcher components and data types.
 */

import type { ComponentReferenceDocumentation } from '../../../types/templates';

// ============================================
// handleGetComponentReference
// ============================================

export function handleGetComponentReference(): {
  action: 'get_component_reference';
  documentation: ComponentReferenceDocumentation;
} {
  return {
    action: 'get_component_reference',
    documentation: {
      overview:
        'Watchers define extraction prompts, schemas, SQL source queries, and optional JSON rendering.',
      data_types: [
        {
          type: 'source',
          description:
            'SQL data source query. If it references the events table, time window bounds are auto-applied via CTE scoping.',
          required_fields: ['name', 'query'],
          example: {
            name: 'daily_volume',
            query:
              "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
          },
        },
      ],
      available_components: [
        {
          name: 'card',
          category: 'Layout',
          description: 'Container with border and padding.',
          example: { type: 'card', children: [{ type: 'text', content: 'Content' }] },
        },
        {
          name: 'each',
          category: 'Control flow',
          description: 'Iterates over arrays in data payload.',
          example: {
            type: 'each',
            items: 'items',
            as: 'item',
            render: { type: 'data', path: 'item.name' },
          },
        },
      ],
      template_variables: [
        {
          variable: '{{entities}}',
          description: 'Comma-separated entity names.',
        },
        {
          variable: '{{#each entities}}{{name}}, {{type}}, {{id}}{{/each}}',
          description: 'Iterate over entities with access to name, type, and id.',
        },
        {
          variable: '{{content}}',
          description: 'All content items formatted as readable text.',
        },
        {
          variable: '{{sources.name}}',
          description: 'Content from a specific named source.',
        },
        {
          variable: '{{data.name}}',
          description: 'Results from a named SQL data source.',
        },
        {
          variable: '{{#each sources}}{{name}}, {{content}}, {{count}}{{/each}}',
          description: 'Iterate over all sources.',
        },
      ],
      security_restrictions: [
        'Templates are declarative; arbitrary JavaScript execution is not supported.',
        'SQL queries are restricted to read-only SELECT/WITH statements.',
      ],
      complete_examples: [
        {
          name: 'Problem Detection',
          description: 'Extracts recurring product issues from source content.',
          prompt: 'Analyze {{entities}} feedback and extract recurring problems.',
          keying_config: {
            entity_type: 'problem',
            entity_path: 'problems',
            key_fields: ['name'],
            key_output_field: 'problem_key',
          },
          data: {
            daily_volume: {
              query:
                "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
            },
          },
        },
      ],
    },
  };
}

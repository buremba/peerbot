/**
 * get_component_reference action handler for manage_behaviors.
 * Returns static documentation about available Behavior components and data types.
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
        'Behaviors define extraction prompts, schemas, SQL source queries, and optional JSON rendering.',
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
      security_restrictions: [
        'Prompts are literal instruction text; no template expansion or code execution happens inside them.',
        'SQL queries are restricted to read-only SELECT/WITH statements.',
      ],
      complete_examples: [
        {
          name: 'Problem Detection',
          description: 'Extracts recurring product issues from source content.',
          prompt:
            "Analyze the bound entities' feedback in the window content and extract recurring problems.",
          outputs: {
            problems: { entity: 'problem', key: ['name'] },
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

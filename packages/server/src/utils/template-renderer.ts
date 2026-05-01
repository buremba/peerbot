/**
 * Template renderer for watcher prompts using Handlebars.
 */

import Handlebars from 'handlebars';
import type { ContentItem } from '../tools/get_content';

interface TemplateEntity {
  id: number;
  name: string;
  type: string;
}

interface TemplateContext {
  sources: Record<string, ContentItem[]>;
  content: ContentItem[];
  entities: TemplateEntity[];
  data?: Record<string, unknown[]>;
}

function formatContentList(items: ContentItem[]): string {
  if (items.length === 0) {
    return '(No content available)';
  }

  return items
    .map((item, idx) => {
      const parts: string[] = [];

      const header = [
        `[${idx + 1}]`,
        item.platform ? `(${item.platform})` : null,
        item.author_name ? `by ${item.author_name}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      parts.push(header);

      if (item.title) {
        parts.push(`Title: ${item.title}`);
      }

      parts.push(item.text_content);

      if (item.score > 0) {
        parts.push(`Score: ${item.score}`);
      }

      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}

/** Array that renders as a string for {{var}} but is iterable for {{#each var}}. */
function stringifiable<T>(items: T[], toStr: () => string): T[] & { toString: () => string } {
  return Object.assign([...items], { toString: toStr });
}

const hbs = Handlebars.create();

hbs.registerHelper('json', (value: unknown) => JSON.stringify(value, null, 2));

function buildContext(context: TemplateContext): Record<string, unknown> {
  const sources: Record<
    string,
    { name: string; content: string; count: number; toString: () => string }
  > = {};
  for (const [name, items] of Object.entries(context.sources)) {
    const formatted = formatContentList(items);
    sources[name] = {
      name,
      content: formatted,
      count: items.length,
      toString: () => formatted,
    };
  }

  const data: Record<string, { toString: () => string }> = {};
  if (context.data) {
    for (const [key, rows] of Object.entries(context.data)) {
      const formatted =
        Array.isArray(rows) && rows.length > 0
          ? JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2)
          : '(No data available)';
      data[key] = { toString: () => formatted };
    }
  }

  return {
    entities: stringifiable(context.entities, () => context.entities.map((e) => e.name).join(', ')),
    content: formatContentList(context.content),
    sources,
    data,
  };
}

export function renderPromptTemplate(template: string, context: TemplateContext): string {
  const compiled = hbs.compile(template, { noEscape: true });
  return compiled(buildContext(context));
}

/**
 * Render a prompt template in preview mode — entities are resolved,
 * but sources/data/content show placeholder labels.
 */
export function renderPromptPreview(
  template: string,
  entities: Array<{ name: string; type: string }>
): string {
  const compiled = hbs.compile(template, { noEscape: true });
  return compiled({
    entities: stringifiable(entities, () => entities.map((e) => e.name).join(', ')),
    content: '[content]',
    sources: new Proxy(
      {},
      { get: (_, prop) => (typeof prop === 'string' ? `[sources.${prop}]` : undefined) }
    ),
    data: new Proxy(
      {},
      { get: (_, prop) => (typeof prop === 'string' ? `[data.${prop}]` : undefined) }
    ),
  });
}

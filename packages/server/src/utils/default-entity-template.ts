/**
 * Auto-generate a default json_template (render DSL root node) from an entity
 * type's `metadata_schema`.
 *
 * Rendering resolution is `instance override → type default → auto-default`.
 * This module is the final tail: when neither the entity nor its type declares
 * a view template, a promoted/typed entity still renders its structured fields
 * as a key/value card instead of falling back to the generic dashboard. A type
 * with no `properties` returns null, so free-form (untyped) entities keep the
 * dashboard overview.
 *
 * The returned value is the renderer ROOT NODE (not the `{ version, root }`
 * wrapper) — that is the shape `resolve_path` returns and the owletto
 * `JsonRenderer` consumes via `template={{ root: entity.json_template }}`.
 */

/** A render-DSL node. Kept loose — the owletto json-renderer owns the vocabulary. */
type TemplateNode = Record<string, unknown>;

interface SchemaProperty {
  title?: unknown;
  description?: unknown;
  ['x-table-label']?: unknown;
  ['x-table-column']?: unknown;
  ['x-hidden']?: unknown;
}

function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function labelFor(key: string, def: SchemaProperty): string {
  if (typeof def['x-table-label'] === 'string' && def['x-table-label']) {
    return def['x-table-label'];
  }
  if (typeof def.title === 'string' && def.title) return def.title;
  return titleCase(key);
}

/**
 * Build a default render template from a metadata schema, or null when the
 * schema has no usable properties (free-form type → keep the dashboard).
 *
 * Field order honors a numeric `x-table-column` annotation when present,
 * otherwise declaration order. Fields annotated `x-hidden` are skipped.
 */
export function buildDefaultEntityTemplate(
  metadataSchema: Record<string, unknown> | null | undefined
): TemplateNode | null {
  const properties = (metadataSchema as { properties?: unknown } | null | undefined)?.properties;
  if (!properties || typeof properties !== 'object') return null;

  const entries = Object.entries(properties as Record<string, SchemaProperty>).filter(
    ([, def]) => !(def && def['x-hidden'] === true)
  );
  if (entries.length === 0) return null;

  const ordered = entries
    .map(([key, def], i) => {
      const col = def?.['x-table-column'];
      return { key, def: def ?? {}, order: typeof col === 'number' ? col : i + 1000 };
    })
    .sort((a, b) => a.order - b.order);

  const rows: TemplateNode[] = ordered.map(({ key, def }) => ({
    type: 'tr',
    children: [
      {
        type: 'th',
        props: {
          className:
            'text-left align-top pr-4 py-1.5 font-medium text-muted-foreground whitespace-nowrap',
        },
        children: [{ type: 'text', content: labelFor(key, def) }],
      },
      {
        type: 'td',
        props: { className: 'align-top py-1.5 break-words' },
        children: [{ type: 'data', path: key, fallback: '—' }],
      },
    ],
  }));

  return {
    type: 'card',
    children: [
      {
        type: 'card-content',
        props: { className: 'pt-6' },
        children: [
          {
            type: 'table',
            props: { className: 'w-full text-sm' },
            children: [{ type: 'tbody', children: rows }],
          },
        ],
      },
    ],
  };
}

/** Coerce a stored view template (JSON string or object) to a render node, or null. */
function coerceTemplate(raw: unknown): TemplateNode | null {
  if (raw == null) return null;
  let tpl: unknown = raw;
  if (typeof raw === 'string') {
    try {
      tpl = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) return null;
  if (Object.keys(tpl as object).length === 0) return null;
  return tpl as TemplateNode;
}

/**
 * The ONE render-resolution primitive — a declared view template wins; otherwise
 * auto-default from the metadata schema. Returns the renderer ROOT NODE, or null
 * when neither a template nor usable schema properties exist (free-form type →
 * dashboard).
 *
 * Every render surface reuses this so a type renders identically everywhere:
 * entity detail (`resolve_path`) and event render (`get_content`). Surface-specific
 * overrides (an entity instance's own template, an event kind's `jsonTemplate`) are
 * applied by the caller as the first argument; the type's declared `viewTemplate`
 * is the fallback that this helper consults before auto-defaulting.
 */
export function resolveEntityRender(
  declaredTemplate: unknown,
  metadataSchema: Record<string, unknown> | null | undefined
): TemplateNode | null {
  return coerceTemplate(declaredTemplate) ?? buildDefaultEntityTemplate(metadataSchema);
}

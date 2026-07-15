/**
 * Recursively deep-copies a TypeBox/JSON schema for embedding in the OpenAPI
 * document, dropping any property marked `x-hidden` at every object level
 * (server-internal fields — pre-computed embeddings, auth-bound filters — that
 * must never reach a client), and pruning them from each `required` array so
 * the copy stays self-consistent. Also strips the `$id`/`static` TypeBox
 * internals that aren't OpenAPI fields.
 *
 * Lives in its own module (no registry import) so both doc projectors — the
 * dispatch-tool surface (`openapi-generator.ts`) and the defineRoute registry
 * (`routes/shared/define-route.ts`) — share ONE schema-embedding path without
 * route modules statically pulling in the tool registry (circular-init risk).
 */
export function deepCopyStrict(schema: any): any {
  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(deepCopyStrict);
  }
  const copied: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$id' || key === 'static') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, any> = {};
      for (const [propKey, propVal] of Object.entries<any>(value)) {
        if (propVal?.['x-hidden']) continue;
        props[propKey] = deepCopyStrict(propVal);
      }
      copied[key] = props;
      continue;
    }
    copied[key] = deepCopyStrict(value);
  }
  // Prune now-hidden keys out of `required` so we never require a dropped field.
  if (Array.isArray(copied.required) && copied.properties) {
    copied.required = copied.required.filter((k: string) => k in copied.properties);
  }
  return copied;
}

/** Rewrite legacy persisted Behavior text into the public SDK vocabulary. */
export function canonicalizeBehaviorText(
  value: string | null | undefined
): string | null | undefined {
  return value?.replaceAll('client.watchers.', 'client.behaviors.');
}

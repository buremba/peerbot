export type SecretRef = string;

export interface ParsedSecretRef {
  raw: SecretRef;
  scheme: string;
  path: string;
  fragment?: string;
}

const SECRET_REF_RE = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i;

export function parseSecretRef(value: string): ParsedSecretRef | null {
  const match = value.match(SECRET_REF_RE);
  if (!match) return null;

  const scheme = match[1]?.toLowerCase();
  const remainder = match[2];
  if (!scheme || !remainder) return null;

  // Split on the FIRST `#` only — `split("#", 2)` would discard anything after
  // a second `#`, silently dropping fragments like `kv/foo#field#sub`.
  const hashIdx = remainder.indexOf("#");
  const path = hashIdx === -1 ? remainder : remainder.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? undefined : remainder.slice(hashIdx + 1);
  if (!path) return null;

  return {
    raw: value,
    scheme,
    path,
    ...(fragment ? { fragment } : {}),
  };
}

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "string" && parseSecretRef(value) !== null;
}

export function createBuiltinSecretRef(name: string): SecretRef {
  return `secret://${name}`;
}

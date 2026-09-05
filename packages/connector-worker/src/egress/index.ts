/**
 * `@lobu/connector-worker/egress` — the Node egress transport shared by the
 * gateway and the connector isolate lane. Policy lives in
 * `@lobu/connector-sdk/egress-policy`; this subpath only knows how to dial.
 */
export {
  __egressTransportTestOnly,
  DnsResolutionError,
  MalformedHostError,
  PrivateAddressError,
  type ResolveAllAddresses,
  fetchCredentialedPublicUrl,
  fetchPublicUrl,
  isInternalUrl,
  parseCredentialedHttpsUrl,
  resolvePublicAddresses,
} from './transport.js';

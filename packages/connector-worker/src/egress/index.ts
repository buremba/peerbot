/**
 * `@lobu/connector-worker/egress` — the Node egress transport the gateway and
 * the connector isolate lane dial through, and the credential placeholders a
 * run resolves at the wire. Policy lives in `@lobu/connector-sdk/egress-policy`
 * and `@lobu/connector-sdk/ip-reachability`; this subpath only knows how to
 * dial and what a placeholder looks like.
 */
export { CREDENTIAL_PLACEHOLDER_PREFIX } from './credentials.js';
export {
  __egressTransportTestOnly,
  DnsResolutionError,
  type EgressAddressOptions,
  EgressDispatcher,
  MalformedHostError,
  PrivateAddressError,
  type ResolveAllAddresses,
  fetchCredentialedPublicUrl,
  fetchPublicUrl,
  isInternalUrl,
  parseCredentialedHttpsUrl,
  parseExemptHosts,
  resolveEgressAddresses,
} from './transport.js';

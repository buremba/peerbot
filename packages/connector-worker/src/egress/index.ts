/**
 * `@lobu/connector-worker/egress` — the Node egress transport the gateway and
 * the connector isolate lane dial through. Policy lives in
 * `@lobu/connector-sdk/egress-policy` and `@lobu/connector-sdk/ip-reachability`;
 * this subpath only knows how to dial.
 */
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

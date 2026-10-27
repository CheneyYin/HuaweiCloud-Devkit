// Stable public face of the proxy config subsystem. The internals live in
// the src/proxy family — proxy-config-io.ts (the on-disk proxy.json store),
// proxy-cidr.ts (the BigInt CIDR engine), and proxy-bypass.ts (the no_proxy
// policy and the env-var resolution tiers); this module is the re-export seam
// every consumer imports — same exported names, same import path, same
// behavior (the safety-policy.ts precedent).

// The config-file IO: the on-disk proxy.json store.
export {
  proxyConfigPath,
  readProxyConfig,
  writeProxyConfig,
  clearProxyConfig,
  type ProxyConfigFile,
} from './proxy-config-io.ts';

// The no_proxy matching policy and the env-var resolution tiers.
export { shouldBypassProxy, getProxySettings, getProxyUrlForTarget, type ProxySettings } from './proxy-bypass.ts';

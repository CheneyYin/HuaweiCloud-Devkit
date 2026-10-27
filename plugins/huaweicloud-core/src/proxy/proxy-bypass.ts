// The no_proxy policy and the proxy resolution tiers: the env-var spelling
// chains (both curl lowercase and CI uppercase) over the config file, the
// no_proxy list semantics (exact match, wildcard, dot-suffix, CIDR via the
// proxy-cidr engine), and the per-target proxy URL pick. Node builtins only;
// the config-file IO lives in proxy-config-io.ts.

import { readProxyConfig } from './proxy-config-io.ts';
import { parseCidr, ipInCidr } from './proxy-cidr.ts';

export interface ProxySettings {
  proxyUrl?: string;
  noProxyList: string[];
  targetProtocol?: string;
  https_proxy?: string;
  http_proxy?: string;
  no_proxy?: string;
}

export function shouldBypassProxy(hostname: string, noProxyList: string[]): boolean {
  if (!noProxyList.length) return false;
  let lower = hostname.toLowerCase();
  // URL.hostname serializes IPv6 literals WITH brackets ([2001:db8::1]) —
  // strip them so CIDR/exact matching sees the bare literal. IPv4-mapped
  // forms arrive hex-normalized from URL parsing; the dotted decoder below
  // is the direct-call surface, so translate the hex form to the v4 int.
  if (lower.startsWith('[') && lower.endsWith(']')) {
    lower = lower.slice(1, -1);
  }
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    if (hi <= 0xffff && lo <= 0xffff) {
      lower = `::ffff:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }
  for (const pattern of noProxyList) {
    const p = pattern.trim().toLowerCase();
    if (!p) continue;
    if (p === lower) return true;
    if (p === '*') return true;
    if (p.includes('/')) {
      const cidr = parseCidr(p);
      if (cidr && ipInCidr(lower, cidr)) return true;
    }
    if (p.startsWith('*.')) {
      const domain = p.slice(1);
      if (lower.endsWith(domain) || lower === p.slice(2)) return true;
    }
    if (p.startsWith('.') && lower.endsWith(p)) return true;
    if (lower.endsWith('.' + p)) return true;
  }
  return false;
}

export function getProxySettings(targetUrl?: string | URL): ProxySettings | null {
  const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || '';
  const envNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';

  const fileConfig = readProxyConfig();

  const https_proxy = envHttps || fileConfig?.https_proxy || fileConfig?.HTTPS_PROXY || '';
  const http_proxy = envHttp || fileConfig?.http_proxy || fileConfig?.HTTP_PROXY || '';
  const no_proxy = envNoProxy || fileConfig?.no_proxy || fileConfig?.NO_PROXY || '';

  if (!https_proxy && !http_proxy) return null;

  const noProxyList = no_proxy
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (targetUrl) {
    const parsed = new URL(targetUrl);
    if (shouldBypassProxy(parsed.hostname, noProxyList)) return null;
    const isHttps = parsed.protocol === 'https:';
    const proxyUrl = isHttps ? https_proxy : http_proxy;
    if (!proxyUrl) return null;
    return { proxyUrl, noProxyList, targetProtocol: parsed.protocol };
  }

  return { https_proxy, http_proxy, no_proxy, noProxyList };
}

export function getProxyUrlForTarget(targetUrl?: string | URL): string | null {
  const settings = getProxySettings(targetUrl);
  if (!settings) return null;
  return settings.proxyUrl || null;
}

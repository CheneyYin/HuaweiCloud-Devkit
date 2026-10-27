// The CIDR engine for no_proxy matching (main 1.1.9): literal IPs only,
// BigInt so the full IPv6 space is representable. IPv4-mapped IPv6
// (::ffff:a.b.c.d) compares against IPv4 CIDRs too — both directions of the
// mixed family. Pure string→BigInt functions, node builtins only; the policy
// layer that walks a no_proxy list lives in proxy-bypass.ts.

function ipv4ToInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256n + BigInt(v);
  }
  return n;
}

function groupsToBigInt(groups: string[]): bigint | null {
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip.toLowerCase();
  if (addr === '::') addr = '0:0:0:0:0:0:0:0';
  const [head, tail] = addr.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  if (addr.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
    if (groups.length !== 8) return null;
    return groupsToBigInt(groups);
  }
  const groups = head ? head.split(':') : [];
  if (groups.length !== 8) return null;
  return groupsToBigInt(groups);
}

function ipv4MappedV6ToBigInt(ip: string): bigint | null {
  // ::ffff:a.b.c.d — IPv4-mapped IPv6. Compare against IPv4 CIDR too.
  const m = ip.match(/^::ffff:([0-9.]+)$/i);
  if (!m) return null;
  return ipv4ToInt(m[1]!);
}

export interface CidrRule {
  bits: 32n | 128n;
  base: bigint;
  mask: bigint;
}

export function parseCidr(pattern: string): CidrRule | null {
  const slash = pattern.lastIndexOf('/');
  if (slash < 0) return null;
  const ipPart = pattern.slice(0, slash);
  const maskPart = pattern.slice(slash + 1);
  if (!/^\d{1,3}$/.test(maskPart)) return null;
  const prefix = Number(maskPart);
  if (ipPart.includes(':')) {
    const mapped = ipv4MappedV6ToBigInt(ipPart);
    if (mapped !== null) {
      if (prefix < 0 || prefix > 32) return null;
      const mask = prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - BigInt(prefix))) - 1n);
      return { bits: 32n, base: mapped, mask };
    }
    const base = ipv6ToBigInt(ipPart);
    if (base === null) return null;
    if (prefix < 0 || prefix > 128) return null;
    const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << (128n - BigInt(prefix))) - 1n);
    return { bits: 128n, base, mask };
  }
  const base = ipv4ToInt(ipPart);
  if (base === null) return null;
  if (prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - BigInt(prefix))) - 1n);
  return { bits: 32n, base, mask };
}

export function ipInCidr(hostname: string, cidr: CidrRule): boolean {
  if (cidr.bits === 32n) {
    const v4 = ipv4ToInt(hostname);
    if (v4 !== null) return (v4 & cidr.mask) === (cidr.base & cidr.mask);
    const mapped = ipv4MappedV6ToBigInt(hostname);
    if (mapped !== null) return (mapped & cidr.mask) === (cidr.base & cidr.mask);
    return false;
  }
  const v6 = ipv6ToBigInt(hostname);
  if (v6 !== null) return (v6 & cidr.mask) === (cidr.base & cidr.mask);
  return false;
}

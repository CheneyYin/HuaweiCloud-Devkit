// Semver channel logic for the update machinery: parsing, prerelease-aware
// precedence, channel detection, and the dist-tag target election. Part of
// the src/update-* family behind the src/update-check.ts re-export face.

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string[] | null;
  raw: string;
}

// dist-tags payload from `npm view` (or the registry). Untyped at the boundary:
// only string versions survive, missing/malformed tags read as null.
export interface DistTags {
  latest?: string | null;
  next?: string | null;
}

export function semverParse(input: unknown): ParsedSemver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(input).trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, raw: String(input).trim() };
}

function comparePre(a: readonly (string | undefined)[] | null, b: readonly (string | undefined)[] | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // 无 prerelease（正式版）更大
  if (b === null) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNum) {
      return -1; // 数字标识符 < 字母标识符
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function semverCompare(a: unknown, b: unknown): number {
  const A = semverParse(a);
  const B = semverParse(b);
  if (!A || !B) {
    const sa = String(a);
    const sb = String(b);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  }
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  return comparePre(A.pre, B.pre);
}

export function hasPrerelease(v: unknown): boolean {
  const parsed = semverParse(v);
  return Boolean(parsed && parsed.pre);
}

export function determineTarget(current: unknown, distTags: DistTags = {}): string | null {
  const isPre = hasPrerelease(current);
  const candidates: string[] = [];
  if (distTags.latest) candidates.push(distTags.latest);
  if (isPre && distTags.next) candidates.push(distTags.next);
  if (!candidates.length) return null;
  return candidates.slice().sort(semverCompare).pop() ?? null;
}

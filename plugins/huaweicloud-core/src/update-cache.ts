// The session-level update cache: the single-flight dist-tags query with TTL
// and failure throttling, the last-hint memo behind peekCachedUpdateInfo, and
// the _updateInfo hint application. Part of the src/update-* family behind
// the src/update-check.ts re-export face.
import { judgeUpdate, type UpdateHint, type UpdateHintLike } from './update-hint.ts';
import type { DistTags } from './update-semver.ts';
import { readSkipState, resolveSkipFilePath } from './update-skip.ts';
import { queryDistTags } from './update-registry.ts';

const TTL_MS = 60 * 60 * 1000;
const FAIL_THROTTLE_MS = 5 * 60 * 1000;

let cachedDistTags: DistTags | null = null;
let cachedAt = 0;
let failedAt = 0;
let inflightQuery: Promise<DistTags | null> | null = null;
let lastHint: UpdateHint | null = null;

export function invalidateUpdateCache(): void {
  cachedDistTags = null;
  cachedAt = 0;
  failedAt = 0;
  inflightQuery = null;
  lastHint = null;
}

function cacheValid(now = Date.now()): boolean {
  return Boolean(cachedDistTags) && now - cachedAt <= TTL_MS;
}

export interface GetCachedUpdateInfoOptions {
  doQuery?: () => Promise<DistTags | null>;
  now?: number;
  sessionId?: string | null;
}

export async function getCachedUpdateInfo(
  current: string,
  { doQuery = queryDistTags, now = Date.now(), sessionId = null }: GetCachedUpdateInfoOptions = {},
): Promise<UpdateHint> {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') {
    lastHint = judgeUpdate(current, null, undefined, now);
    return lastHint;
  }
  const skipState = readSkipState(resolveSkipFilePath(sessionId));
  if (!cacheValid(now)) {
    if (!cachedDistTags && now - failedAt < FAIL_THROTTLE_MS) {
      lastHint = judgeUpdate(current, null, skipState, now);
      return lastHint;
    }
    if (!inflightQuery) {
      inflightQuery = doQuery()
        .then((distTags) => {
          if (distTags) {
            cachedDistTags = distTags;
            cachedAt = now;
          } else {
            failedAt = now;
          }
          return distTags;
        })
        .finally(() => {
          inflightQuery = null;
        });
    }
    const distTags = await inflightQuery;
    lastHint = judgeUpdate(current, distTags, skipState, now);
    return lastHint;
  }
  lastHint = judgeUpdate(current, cachedDistTags, skipState);
  return lastHint;
}

export function peekCachedUpdateInfo(): UpdateHint | null {
  return lastHint && lastHint.updateAvailable && lastHint.targetVersion ? lastHint : null;
}

export async function getUpdateDistTags(
  current: string,
  { sessionId = null, doQuery }: { sessionId?: string | null; doQuery?: () => Promise<DistTags | null> } = {},
): Promise<{ latest: string | null; next: string | null } | null> {
  const result = await getCachedUpdateInfo(current, { sessionId, doQuery });
  if (!result || result.result === 'check_failed') return null;
  return { latest: result.latestStable ?? null, next: result.latestNext ?? null };
}

export function applyUpdateHint(result: unknown, name: string, hint: UpdateHintLike | null): unknown {
  if (!hint || !hint.updateAvailable || !hint.targetVersion) return result;
  if (name === 'huaweicloud_check_update' || name === 'huaweicloud_upgrade') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...(result as Record<string, unknown>),
    _updateInfo: { currentVersion: hint.currentVersion, latestVersion: hint.targetVersion },
  };
}

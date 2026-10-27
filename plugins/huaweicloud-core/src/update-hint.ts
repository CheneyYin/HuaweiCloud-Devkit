// The four-state update verdict (update_available / up_to_date / check_failed /
// dismissed), the cooldown matrix, and the UpdateHint payload shape. Part of
// the src/update-* family behind the src/update-check.ts re-export face.
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import type { SkipState } from './update-skip.ts';

export type UpdateResult = 'update_available' | 'up_to_date' | 'check_failed' | 'dismissed';

export interface UpdateHint {
  currentVersion: string;
  latestStable: string | null;
  latestNext: string | null;
  targetVersion: string | null;
  updateAvailable: boolean;
  dismissed: boolean;
  dismissExpiresAt: string | null;
  result: UpdateResult;
  note?: string;
}

// Structural view of the fields applyUpdateHint reads; partial so callers with
// minimal hints (tests, protocol layer) still typecheck.
export interface UpdateHintLike {
  updateAvailable?: boolean;
  currentVersion?: string;
  targetVersion?: string | null;
}

interface BuildResultExtra {
  target?: string | null;
  result?: UpdateResult;
  dismissExpiresAt?: string | null;
  note?: string;
}

function buildResult(current: string, distTags: DistTags | null, extra: BuildResultExtra = {}): UpdateHint {
  const result: UpdateHint = {
    currentVersion: current,
    latestStable: distTags?.latest ?? null,
    latestNext: distTags?.next ?? null,
    targetVersion: extra.target ?? null,
    updateAvailable: extra.result === 'update_available',
    dismissed: extra.result === 'dismissed',
    dismissExpiresAt: extra.dismissExpiresAt ?? null,
    result: extra.result ?? 'up_to_date',
  };
  if (extra.note) result.note = extra.note;
  return result;
}

export function judgeUpdate(
  current: string,
  distTags: DistTags | null,
  skipState: SkipState | null | undefined,
  now = Date.now(),
): UpdateHint {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') {
    return buildResult(current, distTags ?? null);
  }
  if (!distTags) {
    return buildResult(current, null, { result: 'check_failed', note: '检测失败，不影响使用' });
  }
  // truthy 但无有效版本（如 failure 折叠后的 { latest:null, next:null }）同样视为检测失败
  if (!distTags.latest && !distTags.next) {
    return buildResult(current, null, { result: 'check_failed', note: '检测失败，不影响使用' });
  }
  const target = determineTarget(current, distTags);
  if (!target || semverCompare(target, current) <= 0) {
    return buildResult(current, distTags, { result: 'up_to_date', target: target ?? null });
  }
  const expiresAt = skipState?.expireAt ? new Date(skipState.expireAt).getTime() : 0;
  const inCooldown =
    skipState != null && now < expiresAt && semverCompare(target, String(skipState.dismissedVersion)) <= 0;
  if (inCooldown) {
    return buildResult(current, distTags, {
      result: 'dismissed',
      target,
      dismissExpiresAt: skipState?.expireAt ?? null,
    });
  }
  return buildResult(current, distTags, { result: 'update_available', target });
}

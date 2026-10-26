// Version-update detection & auto-upgrade for huaweicloud-devkit (session-level).
// Spec: docs/superpowers/specs/2026-09-07-version-upgrade-design.md (internal, not committed).
//
// The semver channel logic lives in ./update-semver.ts, the installed-version
// reader in ./update-installed.ts, the skip-state persistence in ./update-skip.ts,
// and the four-state verdict in ./update-hint.ts (all re-exported below); the
// registry IO, cache, and upgrade families still live here.
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

import { fetchWithProxy } from './proxy/proxy-agent.ts';
import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { asText } from './lib/as-text.ts';
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import { readInstalledVersion } from './update-installed.ts';
import { readSkipState, resolveSkipFilePath } from './update-skip.ts';
import { judgeUpdate, type UpdateHint, type UpdateHintLike } from './update-hint.ts';

// The semver channel logic family (parsing, prerelease precedence, target election).
export {
  semverParse,
  semverCompare,
  hasPrerelease,
  determineTarget,
  type ParsedSemver,
  type DistTags,
} from './update-semver.ts';

// The installed-version reader (package.json candidates + plugin-manifest fallbacks, #576).
export { readInstalledVersion } from './update-installed.ts';

// The skip-state (dismiss) persistence family: paths, session suffixing, read/write.
export {
  skipFilePath,
  fallbackSkipFilePath,
  resolveSkipFilePath,
  readSkipState,
  writeSkipState,
  type SkipState,
} from './update-skip.ts';

// The four-state verdict (cooldown matrix) and the UpdateHint payload shape.
export { judgeUpdate, type UpdateResult, type UpdateHint, type UpdateHintLike } from './update-hint.ts';

const IS_WINDOWS = process.platform === 'win32';
const NPM_BIN = IS_WINDOWS ? 'npm.cmd' : 'npm';
const NPX_BIN = IS_WINDOWS ? 'npx.cmd' : 'npx';
const TTL_MS = 60 * 60 * 1000;
const FAIL_THROTTLE_MS = 5 * 60 * 1000;

interface SpawnResultLike {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string } | null;
}

type UpgradeSpawnFn = (
  _command: string,
  _args: readonly string[],
  _options: SpawnSyncOptionsWithStringEncoding,
) => SpawnResultLike;

// One-property read with validation, for the JS boundary of thrown values:
// only a non-empty `message` string is surfaced.
function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message) return record.message;
  }
  return undefined;
}

function toDistTags(value: unknown): DistTags | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    latest: typeof record.latest === 'string' ? record.latest : null,
    next: typeof record.next === 'string' ? record.next : null,
  };
}

export function parseDistTagsOutput(stdout: unknown): DistTags | null {
  try {
    const text = asText(stdout || '').trim();
    if (!text) return null; // 空输出视为 npm view 失败
    return toDistTags(JSON.parse(text));
  } catch {
    return null;
  }
}

function debugLog(message: string): void {
  if (process.env.HUAWEICLOUD_DEVKIT_DEBUG === '1' || process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true') {
    console.error(`[debug] ${message}`);
  }
}

export async function queryDistTagsFetch({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<DistTags | null> {
  let registry = 'https://registry.npmjs.org';
  if (process.env.HUAWEICLOUD_NPM_REGISTRY) {
    registry = process.env.HUAWEICLOUD_NPM_REGISTRY.replace(/\/+$/, '');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchWithProxy(`${registry}/-/package/huaweicloud-devkit/dist-tags`);
    clearTimeout(timer);
    if (!resp || !resp.ok) return null;
    return toDistTags(await resp.json().catch(() => null));
  } catch (error) {
    clearTimeout(timer);
    debugLog(`queryDistTagsFetch: ${errorMessage(error) || String(error)}`);
    return null;
  }
}

export function queryDistTagsSync({
  timeoutMs = 15000,
  cwd,
}: { timeoutMs?: number; cwd?: string } = {}): DistTags | null {
  try {
    const result = spawnSync(NPM_BIN, ['view', 'huaweicloud-devkit', 'dist-tags', '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
      // Windows + Node 22: spawning `npm.cmd` directly throws EINVAL (CVE-2024-27980
      // mitigation); shell:true routes the .cmd through cmd.exe like other spawns (#643).
      shell: true,
    });
    if (result.status !== 0) {
      debugLog(`queryDistTagsSync: npm view exited with status ${result.status}`);
      return null;
    }
    return parseDistTagsOutput(result.stdout);
  } catch (error) {
    debugLog(`queryDistTagsSync: ${errorMessage(error) || String(error)}`);
    return null;
  }
}

export function queryDistTags({
  timeoutMs = 15000,
  cwd,
}: { timeoutMs?: number; cwd?: string } = {}): Promise<DistTags | null> {
  // Registry seam: the CLI face already honors HUAWEICLOUD_NPM_REGISTRY
  // (setup-cli's update command); the tool face silently ignored it — this
  // delegation closes that inconsistency, so every default consumer
  // (getCachedUpdateInfo, upgradePackage) honors the operator/E2E override
  // without spawning npm.
  if (process.env.HUAWEICLOUD_NPM_REGISTRY) {
    return queryDistTagsFetch({ timeoutMs });
  }
  return new Promise<DistTags | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(NPM_BIN, ['view', 'huaweicloud-devkit', 'dist-tags', '--json'], {
        windowsHide: true,
        cwd,
        shell: true,
      });
    } catch (error) {
      debugLog(`queryDistTags: ${errorMessage(error) || String(error)}`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // the child may have already exited; the timeout path resolves null regardless
      }
      debugLog(`queryDistTags: timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      debugLog(`queryDistTags: ${errorMessage(error) || String(error)}`);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(parseDistTagsOutput(stdout));
      } else {
        debugLog(`queryDistTags: npm view exited with code ${code}`);
        resolve(null);
      }
    });
  });
}

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

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnResultLike {
  return spawnSync(command, args, options);
}

function restartMessage(target: string): string {
  if (target === 'officeace') {
    return '升级完成，请打开连接器 → 我的连接器 → huaweicloud-devkit → 重新连接后使用新版本。';
  }
  return '升级完成，请重启当前会话使新版本生效。';
}

export interface UpgradeOptions {
  doQuery?: () => Promise<DistTags | null>;
  spawnFn?: UpgradeSpawnFn;
  currentVersion?: string;
}

export async function upgradePackage(
  { target = 'all', version = 'latest' }: { target?: string; version?: string } = {},
  options: UpgradeOptions = {},
) {
  if (version !== 'latest') {
    return { success: false, error: 'version 参数仅支持 latest。目标版本由插件自动判定。' };
  }
  // The target is interpolated into an npx command spawned with shell:true;
  // reject anything outside the known agent set + 'all' so a crafted value
  // cannot be interpreted as shell operators (review #717).
  const targetStr = String(target);
  if (targetStr !== 'all' && !SUPPORTED_AGENT_TARGETS.includes(targetStr)) {
    return { success: false, error: `不支持的升级目标：${targetStr}` };
  }
  const { doQuery = queryDistTags, spawnFn = defaultSpawn } = options;
  // Tests inject currentVersion explicitly - the repo package.json version changes
  // between prerelease and stable lines, which must not flip the upgrade-tag logic.
  const previousVersion = options.currentVersion || readInstalledVersion();
  let distTags: DistTags | null;
  try {
    distTags = await doQuery();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  const targetVersion = determineTarget(previousVersion, distTags ?? {});
  if (distTags === null) {
    return {
      success: false,
      error: '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  if (!targetVersion) {
    return { success: false, message: '已是最新版本，无需升级。', requiresRestart: false };
  }
  const isNextTarget = Boolean(distTags.next && semverCompare(targetVersion, distTags.next) === 0);
  const tag = isNextTarget ? 'next' : 'latest';
  const command = ['--yes', `huaweicloud-devkit@${tag}`, 'update', '--target', String(target)];
  let execResult: SpawnResultLike;
  try {
    execResult = spawnFn(NPX_BIN, command, { encoding: 'utf8', timeout: 300000, windowsHide: true, shell: true });
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '升级命令执行失败。',
      manual: `npx --yes huaweicloud-devkit@${tag} update --target ${target}`,
    };
  }
  if (execResult.status === 0) {
    invalidateUpdateCache();
    return {
      success: true,
      previousVersion,
      installedVersion: targetVersion,
      requiresRestart: true,
      message: restartMessage(target),
    };
  }
  const errObj = execResult.error;
  const stderr = String(execResult.stderr || '').trim();
  const reason = errObj?.message
    ? errObj.message
    : stderr
      ? stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
      : `exit ${execResult.status}`;
  return {
    success: false,
    error: reason,
    manual: `npx --yes huaweicloud-devkit@${tag} update --target ${target}`,
  };
}

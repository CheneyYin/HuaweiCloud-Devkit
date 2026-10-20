import { homedir } from 'node:os';
import { join } from 'node:path';

// Leaf module for the KooCLI preinstall lock/log paths — consumed by BOTH
// src/preflight.ts (lock/log writer) and src/hcloud-probe.ts (the not_found
// hint quotes the log path). Keeping the paths here breaks what would
// otherwise be an import cycle preflight ⇄ hcloud-probe (preflight imports
// findHcloudBin from hcloud-probe). Env is read at CALL time so tests can
// redirect per-case; HUAWEICLOUD_HOME is the established v2 convention
// (dep/receipts.ts, lib/pack-state.ts).
function configBase(): string {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function kooCliInstallLogPath(): string {
  return join(configBase(), '.config', 'huaweicloud', 'logs', 'koocli-install.log');
}

export function kooCliInstallLockPath(): string {
  return join(configBase(), '.config', 'huaweicloud', '.koocli-install.lock');
}

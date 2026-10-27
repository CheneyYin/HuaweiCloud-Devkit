import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage, sleepSync } from './payload-utils.ts';

// The verified file operations every per-agent deploy shares (the
// install-payload.ts internals split). copyFileVerified is the retrying
// size-checked copy the whole installer routes through; removeIfExists is
// the #556 retrying removal the native-skill cleanup and the uninstalls
// route through.

export function copyFileVerified(src: string, dest: string): void {
  const expected = statSync(src).size;
  for (let attempt = 1; attempt <= 3; attempt++) {
    copyFileSync(src, dest);
    let actual = -1;
    try {
      actual = statSync(dest).size;
    } catch {
      // destination missing - fall through to retry
    }
    if (actual === expected) return;
    if (attempt < 3) sleepSync(150);
  }
  throw new Error(
    `copyDir verification failed after 3 attempts: ${src} -> ${dest} (expected ${expected} bytes). ` +
      `The destination file may be locked by another process (e.g. a running agent session using the installed MCP server). ` +
      `Close it and re-run the install.`,
  );
}

export function mcpServerInstalled(baseDir: string): boolean {
  return existsSync(join(baseDir, 'dist', 'mcp-server.js')) || existsSync(join(baseDir, 'src', 'mcp-server.mjs'));
}

export function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileVerified(s, d);
    }
  }
}

// Remove huawei* entries in targetDir that no longer exist in sourceDir (stale files from an older version).
export function pruneStale(targetDir: string, sourceDir: string): number {
  if (!existsSync(targetDir) || !existsSync(sourceDir)) return 0;
  const sourceNames = new Set(readdirSync(sourceDir));
  let removed = 0;
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('huawei')) continue;
    if (!sourceNames.has(entry.name)) {
      if (removeIfExists(join(targetDir, entry.name))) removed++;
    }
  }
  return removed;
}

export function removeIfExists(p: string): boolean {
  if (existsSync(p)) {
    try {
      // Retry transient EBUSY/EPERM/ENOTEMPTY (locked files on Windows) before
      // giving up — uninstall should not leave a skill behind just because a
      // handle was momentarily open (#556).
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not remove ${p}: ${errorMessage(error)}`);
      return false;
    }
  }
  return false;
}

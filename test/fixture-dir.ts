import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared temp-fixture registry for test files. A raw mkdtempSync fixture a
// test does not individually rmSync leaks into TMPDIR on every run —
// invisible on tmpfs /tmp where a reboot clears the slate, until the
// 2026-10-09 ext4 lock-verification runs pointed TMPDIR at $HOME and left
// 614 fixture dirs in the home directory. fixtureDir() creates the same
// mkdtemp fixture but registers it for best-effort removal at process
// exit, so a run leaves TMPDIR exactly as it started regardless of
// per-test cleanup discipline. Files that already clean per-test
// (dep-receipts, agent-install, packs-command) keep their finally blocks;
// the registry is the net no call site can forget. Residuals: signal-
// delivered death (SIGKILL, or SIGINT/SIGTERM under Node's default
// disposition — no exit handlers run) leaks everything registered, and a
// fixture a test deliberately left non-writable stays behind rather than
// failing the run.
const fixtureDirs: string[] = [];
process.on('exit', () => {
  for (const dir of fixtureDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort by design: cleanup must never fail a test run
    }
  }
});

export function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

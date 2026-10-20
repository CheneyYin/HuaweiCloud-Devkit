import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Reading the source instead of importing it: mcp-server.ts registers stdin
// listeners at module top level, which would hang node --test.
const source = readFileSync(new URL('../plugins/huaweicloud-core/src/mcp-server.ts', import.meta.url), 'utf8');

test('mcp-server wires the KooCLI preinstall: import, stdio-only call, try/catch swallow', () => {
  assert.match(source, /import \{ maybePreinstallKooCli \} from '\.\/preflight\.ts';/);
  // The call must sit in the stdio branch — the stateless remote (one
  // process per HTTP request) must not churn the lock or trigger
  // unattended downloads from an unauthenticated face.
  const stdioBranch = source.slice(source.indexOf('} else {'), source.indexOf('void runStdioServer();'));
  assert.ok(stdioBranch.includes('maybePreinstallKooCli()'), 'preinstall must be called inside the stdio branch');
  const remoteBranch = source.slice(source.indexOf("if (transport === 'remote')"), source.indexOf('} else {'));
  assert.ok(!remoteBranch.includes('maybePreinstallKooCli'), 'remote branch must not preinstall');
  // Fire-and-forget: never awaited, never fatal.
  assert.match(source, /try \{\s*maybePreinstallKooCli\(\);\s*\} catch \{\s*\/\/ best-effort/s);
});

test('maybePreinstallKooCli returns immediately with the skip flag set (live check)', async () => {
  process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
  try {
    const { maybePreinstallKooCli } = await import('../plugins/huaweicloud-core/src/preflight.ts');
    const t0 = Date.now();
    const result = maybePreinstallKooCli();
    const elapsed = Date.now() - t0;
    assert.equal(result.launched, false);
    assert.equal(result.reason, 'disabled_by_env');
    assert.ok(elapsed < 1000, `skip must be immediate (took ${elapsed}ms) — no real background install may run`);
  } finally {
    process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
  }
});

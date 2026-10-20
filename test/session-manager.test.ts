import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWsExecIndexUrl,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  getCurrentWorkspaceId,
  setWorkspaceId,
  formatPortConflictWarning,
  formatPortDriftWarning,
  resolveProxyNodePort,
  buildExposeRemediation,
  TUNNEL_URL_PATTERN,
  _setSessionConnectorForTests,
  execWithSession,
  closeAllSessions,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.ts';

// Models the real HwlinkTerminalExecSession failure surface: once the
// transport dies (state 'closed'), every exec rejects with the
// closed-before-marker error until the entry is evicted from the cache.
class FakeSession {
  state: 'opening' | 'ready' | 'closed' = 'ready';
  execCalls: string[] = [];
  close() {}
  async exec(command: string): Promise<{ stdout: string; exitCode: number }> {
    if (this.state === 'closed') {
      throw new Error('hwlink terminal closed before completion marker');
    }
    this.execCalls.push(command);
    return { stdout: command, exitCode: 0 };
  }
}

test('a dead cached session is evicted and replaced on the next exec', async () => {
  const made: FakeSession[] = [];
  _setSessionConnectorForTests(async () => {
    const session = new FakeSession();
    made.push(session);
    return session;
  });
  try {
    const first = await execWithSession('ws-evict-test', 'echo one', 'root');
    assert.equal(first.stdout, 'echo one');
    made[0].state = 'closed';
    const second = await execWithSession('ws-evict-test', 'echo two', 'root');
    assert.equal(second.stdout, 'echo two');
    assert.equal(made.length, 2, 'a closed session must not be reused');
    assert.deepEqual(made[1].execCalls, ['echo two']);
  } finally {
    _setSessionConnectorForTests(null);
    closeAllSessions();
  }
});

test('a live cached session is reused without reconnecting', async () => {
  const made: FakeSession[] = [];
  _setSessionConnectorForTests(async () => {
    const session = new FakeSession();
    made.push(session);
    return session;
  });
  try {
    await execWithSession('ws-reuse-test', 'echo one', 'root');
    await execWithSession('ws-reuse-test', 'echo two', 'root');
    assert.equal(made.length, 1, 'a live session must be cached, not recreated');
    assert.deepEqual(made[0].execCalls, ['echo one', 'echo two']);
  } finally {
    _setSessionConnectorForTests(null);
    closeAllSessions();
  }
});

test('ws-exec dynamic import uses file:// URL (Windows-safe)', async () => {
  const wsExecIndexUrl = resolveWsExecIndexUrl();
  assert.ok(wsExecIndexUrl.startsWith('file://'), `expected file:// URL, got: ${wsExecIndexUrl}`);
  const mod = await import(wsExecIndexUrl);
  assert.equal(typeof mod.connectHwlinkTerminalSession, 'function');
  assert.equal(typeof mod.executeHwlinkCommand, 'function');
});

test('splitBase64Chunks splits into chunks no larger than the limit and reassembles losslessly', () => {
  const base64 = Buffer.from('x'.repeat(100000)).toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= UPLOAD_CHUNK_SIZE, `chunk exceeds limit: ${chunk.length}`);
  }
  assert.equal(chunks.join(''), base64);
});

test('splitBase64Chunks returns a single chunk for small inputs', () => {
  const base64 = Buffer.from('hello').toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], base64);
});

test('currentWorkspaceId defaults to null without env or setter', () => {
  assert.equal(getCurrentWorkspaceId(), null);
});

test('setWorkspaceId caches and updates env var', () => {
  const testId = 'test-workspace-123';
  setWorkspaceId(testId);
  assert.equal(getCurrentWorkspaceId(), testId);
  assert.equal(process.env.HW_WORKSPACE_ID, testId);
  setWorkspaceId(null);
});

test('formatPortConflictWarning returns undefined when port is unchanged', () => {
  assert.equal(formatPortConflictWarning(80, 80), undefined);
});

test('formatPortConflictWarning reports the real auto-assigned port', () => {
  assert.equal(formatPortConflictWarning(80, 81), 'Port 80 is in use — auto-assigned port 81');
});

test('formatPortDriftWarning is undefined without drift', () => {
  assert.equal(formatPortDriftWarning(80, 80), undefined);
});

test('formatPortDriftWarning names both ports and the re-bind command', () => {
  const msg = formatPortDriftWarning(80, 81);
  assert.match(msg!, /nginx now listens on port 81/);
  assert.match(msg!, /devbridge port create <tunnelId> -p 81 --protocol http -a/);
});

test('buildExposeRemediation includes credential sourcing and host command with port', () => {
  const msg = buildExposeRemediation(82);
  assert.match(msg, /source \/tmp\/hw_creds\.sh/);
  assert.match(msg, /source \/tmp\/hw_api_key/);
  assert.match(msg, /devbridge port create <tunnelId> -p 82 --protocol http -a/);
  assert.match(msg, /use THAT port instead/);
});

test('TUNNEL_URL_PATTERN matches a real tunnel URL', () => {
  const m = 'TUNNEL_URL:https://c4rdv7bv-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN);
  assert.ok(m, 'valid URL should match');
  assert.equal(m[1], 'https://c4rdv7bv-80.devbridge-s2.hwtunnel.com');
});

test('TUNNEL_URL_PATTERN rejects URL with empty tunnel prefix', () => {
  assert.equal('TUNNEL_URL:https://-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN), null);
});

test('TUNNEL_URL_PATTERN no longer matches the migrated legacy domain', () => {
  assert.equal('TUNNEL_URL:https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN), null);
});

test('resolveProxyNodePort defaults to nginxListenPort + 1 when no nodePort is given', async () => {
  const port = await resolveProxyNodePort(undefined, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort keeps the explicit nodePort when it differs from the nginx listen port', async () => {
  const port = await resolveProxyNodePort(82, 80, async () => false);
  assert.equal(port, 82);
});

test('resolveProxyNodePort falls back to nginxListenPort + 1 when nodePort collides with the nginx listen port', async () => {
  const port = await resolveProxyNodePort(80, 80, async () => false);
  assert.equal(port, 81);
});

test('resolveProxyNodePort re-probes upward when the default candidate is in use', async () => {
  const used = new Set([81]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 82);
});

test('resolveProxyNodePort re-probes upward when the explicit nodePort is in use', async () => {
  const used = new Set([82]);
  const port = await resolveProxyNodePort(82, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

test('resolveProxyNodePort re-probes past targetPort + 1 when it is occupied', async () => {
  const used = new Set([81, 82]);
  const port = await resolveProxyNodePort(undefined, 80, async (p) => used.has(p));
  assert.equal(port, 83);
});

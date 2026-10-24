import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queryDistTagsSync,
  queryDistTags,
  queryDistTagsFetch,
  getCachedUpdateInfo,
  invalidateUpdateCache,
} from '../plugins/huaweicloud-core/src/update-check.ts';

test('queryDistTagsSync 成功返回 distTags 对象', () => {
  const result = queryDistTagsSync({ timeoutMs: 5000 });
  // 结果允许为 null（离线/超时）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTags 异步非阻塞: 同步调用立即返回 Promise', async () => {
  const before = Date.now();
  const p = queryDistTags({ timeoutMs: 5000 });
  const callMs = Date.now() - before;
  assert.ok(p instanceof Promise, 'queryDistTags 应返回 Promise');
  assert.ok(callMs < 100, `queryDistTags 同步调用应非阻塞, 实际耗时 ${callMs}ms`);
  const result = await p;
  // 结果允许为 null（离线/超时）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTagsFetch 直接 fetch registry 返回 distTags', async () => {
  const result = await queryDistTagsFetch({ timeoutMs: 15000 });
  // 结果允许为 null（受限网络）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTagsFetch 尊重 HUAWEICLOUD_NPM_REGISTRY 覆盖', async () => {
  const prev = process.env.HUAWEICLOUD_NPM_REGISTRY;
  process.env.HUAWEICLOUD_NPM_REGISTRY = 'http://127.0.0.1:1';
  try {
    const result = await queryDistTagsFetch({ timeoutMs: 2000 });
    assert.equal(result, null); // 不可达 registry → 静默降级 null
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_NPM_REGISTRY;
    else process.env.HUAWEICLOUD_NPM_REGISTRY = prev;
  }
});

test('queryDistTags 在 HUAWEICLOUD_NPM_REGISTRY 设置时委托 fetch 路径(不 spawn npm)', async () => {
  // 端到端证明委托:本地 server 供 dist-tags,queryDistTags 直接返回其内容。
  // 若仍走 npm view 子进程,请求不会到达该 server,断言失败。
  const seen: string[] = [];
  const server = await import('node:http').then((http) =>
    http.createServer((req, res) => {
      seen.push(String(req.url));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ latest: '0.0.1', next: '0.0.1' }));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const prev = process.env.HUAWEICLOUD_NPM_REGISTRY;
  process.env.HUAWEICLOUD_NPM_REGISTRY = `http://127.0.0.1:${port}`;
  try {
    const result = await queryDistTags({ timeoutMs: 5000 });
    assert.deepEqual(result, { latest: '0.0.1', next: '0.0.1' });
    assert.ok(
      seen.some((url) => url.includes('/-/package/huaweicloud-devkit/dist-tags')),
      `expected the dist-tags fetch, saw: ${seen.join(', ')}`,
    );
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_NPM_REGISTRY;
    else process.env.HUAWEICLOUD_NPM_REGISTRY = prev;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('queryDistTagsSync 失败时在 DEBUG 下输出日志而非静默', () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_DEBUG;
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logs.push(String(msg));
  process.env.HUAWEICLOUD_DEVKIT_DEBUG = '1';
  try {
    // 指向不可达 registry 的 npm view 会失败（fast，避免慢网拖长）
    const result = queryDistTagsSync({
      timeoutMs: 2000,
      cwd: '/nonexistent-dir-to-force-failure',
    });
    assert.equal(result, null);
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.HUAWEICLOUD_DEVKIT_DEBUG;
    else process.env.HUAWEICLOUD_DEVKIT_DEBUG = prev;
  }
  assert.ok(
    logs.some((l) => l.includes('[debug] queryDistTagsSync')),
    `expected debug log, got: ${logs}`,
  );
});

test('getCachedUpdateInfo 单飞: 并发只查一次', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const fakeQuery = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { latest: '1.1.1', next: null };
  };
  const [a, b] = await Promise.all([
    getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery }),
    getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.result, 'update_available');
  assert.equal(b.result, 'update_available');
  assert.equal(a.targetVersion, '1.1.1');
  invalidateUpdateCache();
});

test('getCachedUpdateInfo TTL: 未过期不重复查询', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const fakeQuery = async () => {
    calls++;
    return { latest: '1.2.0', next: null };
  };
  assert.equal((await getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery })).result, 'update_available');
  assert.equal((await getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery })).result, 'update_available');
  assert.equal(calls, 1);
  invalidateUpdateCache();
});

test('getCachedUpdateInfo 失败节流: 失败后短时间不重查', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const failQuery = async () => {
    calls++;
    return null;
  };
  const r1 = await getCachedUpdateInfo('1.0.2', { doQuery: failQuery });
  const r2 = await getCachedUpdateInfo('1.0.2', { doQuery: failQuery });
  assert.equal(r1.result, 'check_failed');
  assert.equal(r2.result, 'check_failed');
  assert.equal(calls, 1); // 同会话节流
  invalidateUpdateCache();
});

test('#607: getUpdateDistTags 在查询失败态(check_failed)应返回 null', async () => {
  const m = await import('../plugins/huaweicloud-core/src/update-check.ts');
  invalidateUpdateCache();
  // doQuery 失败 → getCachedUpdateInfo 返回 check_failed；getUpdateDistTags 应折叠为 null
  const dt = await m.getUpdateDistTags('1.1.0', { doQuery: async () => null });
  assert.equal(dt, null, '失败态应折叠为 null');
});

test('#607: dismiss + 查询失败 → 折叠为 check_failed（不落伪冷却）', async () => {
  const m = await import('../plugins/huaweicloud-core/src/update-check.ts');
  invalidateUpdateCache();
  const f = m.resolveSkipFilePath('sess-607');
  const { rmSync } = await import('node:fs');
  try {
    rmSync(f, { force: true });
  } catch {
    // 预清理上次残留的 skip 文件；失败无妨，下方仍断言其不存在
  }
  // 模拟 dismiss 路径的处理：查询失败 → getUpdateDistTags null → judgeUpdate null
  const dt = await m.getUpdateDistTags('1.1.0', { doQuery: async () => null, sessionId: 'sess-607' });
  assert.equal(dt, null);
  const r = m.judgeUpdate('1.1.0', dt, null);
  assert.equal(r.result, 'check_failed');
  assert.ok(!r.dismissed);
  // 且不得写任何 skip 文件
  const fs = await import('node:fs');
  assert.ok(!fs.existsSync(f), '查询失败不得写 skip 冷却文件');
});

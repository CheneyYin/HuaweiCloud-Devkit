import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
} from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';

// The round-2 hardening of the CLI face's approval store: canonical
// hashing (agent re-serialization cannot change a token's hash) and the
// exclusive-create marker that closes the two-process double-consume window.

function withAuthHome(fn: () => void | Promise<unknown>): () => Promise<void> {
  return async () => {
    const previous = process.env.HUAWEICLOUD_HOME;
    const home = mkdtempSync(join(tmpdir(), 'approval-home-'));
    process.env.HUAWEICLOUD_HOME = home;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = previous;
    }
  };
}

test('hashArgs is canonical: key order never changes the hash', () => {
  assert.equal(hashArgs({ b: 2, a: 1 }), hashArgs({ a: 1, b: 2 }));
  assert.equal(
    hashArgs({ z: { y: [{ b: 2, a: 1 }], x: 'k' }, m: [3, 2, 1] }),
    hashArgs({ m: [3, 2, 1], z: { x: 'k', y: [{ a: 1, b: 2 }] } }),
    'sorting is recursive',
  );
  // Arrays keep their order: order is semantic (a CLI command's argv).
  assert.notEqual(hashArgs(['a', 'b']), hashArgs(['b', 'a']));
  // undefined-valued keys stringify away on both sides — pinned so nobody
  // "fixes" it into a behavior change for in-flight tokens.
  assert.equal(hashArgs({ a: 1, b: undefined }), hashArgs({ a: 1 }));
});

test('hashArgs sees nested __proto__ keys: the prototype-setter bypass is closed', () => {
  // JSON.parse makes __proto__ an OWN property; a plain-object canonical
  // target invoked the prototype setter instead, dropping the key from
  // the hash — so an approved form and a smuggled __proto__ replay hashed
  // identically (round-5 probe). The null-prototype target keeps it.
  const base = JSON.parse('{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1}}}');
  const smuggled = JSON.parse(
    '{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1,"__proto__":{"admin":true}}}}',
  );
  assert.notEqual(hashArgs(base), hashArgs(smuggled), 'a __proto__ payload must not hash as its clean form');
  assert.equal(
    hashArgs(smuggled),
    hashArgs(JSON.parse(JSON.stringify(smuggled))),
    'round-trip stability for the smuggled form',
  );
});

test(
  'the full mint/consume path round-trips a __proto__-bearing approval',
  withAuthHome(() => {
    // hashArgs alone does not cover the file round-trip: the persisted
    // entry's argsHash must survive JSON serialization of the store and
    // still distinguish the smuggled form.
    const smuggled = JSON.parse(
      '{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1,"__proto__":{"admin":true}}}}',
    );
    const clean = JSON.parse('{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1}}}');
    const smuggledToken = createApprovalToken(smuggled);
    const cleanToken = createApprovalToken(clean);

    const fromSmuggled = consumeApprovalToken(smuggledToken);
    assert.ok(fromSmuggled, 'the smuggled entry is consumable');
    assert.equal(fromSmuggled.argsHash, hashArgs(smuggled));
    assert.notEqual(fromSmuggled.argsHash, hashArgs(clean), 'the stored hash keeps the smuggled form distinct');

    const wrongShape = consumeApprovalToken(cleanToken);
    assert.ok(wrongShape);
    assert.notEqual(wrongShape.argsHash, fromSmuggled.argsHash);
  }),
);

test('hashArgs serializes DAG-aliased references structurally, not as null', () => {
  // Round-7: the seen-set was a global visited set — the second reference
  // to the same object collapsed to null, making {a:X,b:X} hash identically
  // to {a:X,b:null}. A recursion-path set (add before, delete after)
  // serializes the DAG faithfully; only true cycles collapse.
  const shared = { k: 1 };
  const aliased = { a: shared, b: shared };
  const expanded = { a: { k: 1 }, b: { k: 1 } };
  const withNull = { a: { k: 1 }, b: null };
  assert.equal(hashArgs(aliased), hashArgs(expanded), 'aliasing does not change the hash');
  assert.notEqual(hashArgs(aliased), hashArgs(withNull), 'a null sibling is a different value');
  // True cycles still terminate — objects AND arrays (round-8: the array
  // branch bypassed the recursion-path set and a self-referential array
  // threw RangeError).
  const cyclic: Record<string, unknown> = { k: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => hashArgs(cyclic));
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  assert.doesNotThrow(() => hashArgs({ tool: 't', toolArgs: { x: cyclicArray } }));
});

test(
  'single-use is enforced by an exclusive-create marker next to the store',
  withAuthHome(() => {
    const token = createApprovalToken({ tool: 'execute_api', toolArgs: { product: 'ECS', api: 'ListServers' } });
    const first = consumeApprovalToken(token);
    assert.ok(first, 'the first consume wins');
    assert.equal(
      first.argsHash,
      hashArgs({ tool: 'execute_api', toolArgs: { api: 'ListServers', product: 'ECS' } }),
      'the stored hash is order-insensitive to how the mint payload was written',
    );

    assert.equal(consumeApprovalToken(token), null, 'replay is rejected by the marker, not just the file');
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    assert.ok(existsSync(join(markerDir, `${token}.claimed`)), 'the claim marker is on disk');
  }),
);

test(
  'consumed markers are pruned long after the TTL window',
  withAuthHome(() => {
    const token = createApprovalToken(['OBS', 'ls']);
    consumeApprovalToken(token);
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    const marker = join(markerDir, `${token}.claimed`);
    assert.ok(existsSync(marker));

    // Age the marker past the prune threshold (4x TTL) and mint again: the
    // mint pass sweeps stale markers alongside stale entries.
    const aged = new Date(Date.now() - 6 * 60_000 * 4);
    utimesSync(marker, aged, aged);
    createApprovalToken(['OBS', 'stat']);
    assert.ok(!existsSync(marker), 'the aged marker is pruned by the next mint');
    const remaining = readdirSync(markerDir);
    assert.ok(remaining.every((name) => name !== `${token}.claimed`));
  }),
);

test(
  'the claim marker, not the file deletion, rejects a racing second consumer',
  withAuthHome(() => {
    const token = createApprovalToken({ tool: 't', toolArgs: { a: 1 } });
    const first = consumeApprovalToken(token);
    assert.ok(first, 'the first consume wins and deletes the entry');

    // Simulate the racing reader: it read the store BEFORE the winner's
    // delete landed, so the entry is back while the marker exists. Only
    // the exclusive-create marker can reject this replay — if the marker
    // gate regresses, this consume would succeed and the test fails.
    const file = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[token] = { argsHash: first.argsHash, argsRedacted: first.argsRedacted, createdAt: Date.now() };
    writeFileSync(file, JSON.stringify(map));
    assert.equal(consumeApprovalToken(token), null, 'the replayed token must be rejected by the marker');
    assert.equal(consumeApprovalToken(token), null, 'and stays rejected');
  }),
);

test(
  'bogus tokens have zero filesystem side effects',
  withAuthHome(() => {
    const probe = `trav-probe-${process.pid}`;
    for (const bogus of ['not-a-uuid', `../../../../${probe}`, '', 'UPPERCASE-NOT-A-TOKEN', `${probe}`]) {
      assert.equal(consumeApprovalToken(bogus), null);
    }
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    assert.ok(
      !existsSync(markerDir) || readdirSync(markerDir).length === 0,
      'no marker files may be created for bogus tokens',
    );
    // The traversal string must not have escaped the (never-created) marker dir.
    assert.ok(!existsSync(join(tmpdir(), `${probe}.claimed`)), 'no traversal escape into tmpdir');
    assert.ok(!existsSync(join(process.env.HUAWEICLOUD_HOME!, `${probe}.claimed`)), 'no traversal escape into home');
  }),
);

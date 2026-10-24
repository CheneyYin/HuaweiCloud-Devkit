import assert from 'node:assert/strict';
import test from 'node:test';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  type HcloudPlan,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { fakeHcloudExecutable, withTempAuthHome, type ApprovedRunResult } from './hcloud-cli-harness.ts';
import { callTool, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';

test('inspectApprovalToken classifies a fresh token as valid', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry, 'valid state carries the stored entry');
    assert.equal(inspection.entry.argsHash, hashArgs(['ECS', 'ListServersDetails']));
  });
});

// Backdate a stored token past the 5-minute TTL.
function backdateToken(home: string, token: string): void {
  const file = join(home, '.config', 'huaweicloud', 'approvals.json');
  const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { createdAt: number }>;
  map[token]!.createdAt = Date.now() - 6 * 60_000;
  writeFileSync(file, JSON.stringify(map), 'utf8');
}

test('inspectApprovalToken classifies an expired token as expired', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    backdateToken(home, token);

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'expired');
    assert.equal(inspection.entry, undefined, 'expired state does not leak the entry');
  });
});

test('inspectApprovalToken classifies an already-consumed token as already_consumed', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first, 'first consume returns the stored entry');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'already_consumed');
  });
});

test('inspectApprovalToken classifies an unknown token as not_found', async () => {
  await withTempAuthHome(() => {
    const inspection = inspectApprovalToken('never-created-uuid');
    assert.equal(inspection.state, 'not_found');
  });
});

test('consumeApprovalToken keeps a tombstone so the second call is distinguishable from not_found', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first);
    // Second consume still returns null (backward compatible), but
    // inspectApprovalToken must report already_consumed, not not_found.
    assert.equal(consumeApprovalToken(token), null);
    assert.equal(inspectApprovalToken(token).state, 'already_consumed');
  });
});

// D4-24 drivers: plan an approval and run it under a fake HCLOUD_BIN, with
// the env restored either way.
async function withFakeHcloudBin<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
  const prevBin = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fake;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
  }
}

async function planApproval(): Promise<string> {
  const plan = (await callTool('huaweicloud_plan_cli_command', {
    args: ['ECS', 'ListServersDetails'],
    vendorConfirmed: 'test: vendor established by the harness',
  })) as HcloudPlan;
  assert.ok(plan.approvalToken);
  return plan.approvalToken;
}

async function runApproved(token: string): Promise<ToolArgs> {
  return (await callTool('huaweicloud_run_approved_command', {
    args: ['ECS', 'ListServersDetails'],
    approvalToken: token,
    approvedByUser: true,
    maxRetries: 0,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as ToolArgs;
}

test('runApprovedCommand: expired token returns {status:rejected, code:CONFIRM_TOKEN_EXPIRED}', async () => {
  await withTempAuthHome(async (home) => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();
      backdateToken(home, token);

      const result = (await runApproved(token)) as { status: string; code: string };
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONFIRM_TOKEN_EXPIRED');
    });
  });
});

test('runApprovedCommand: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();

      const first = (await runApproved(token)) as ApprovedRunResult;
      assert.equal(first.approved, true, 'first call executes the command');

      const second = (await runApproved(token)) as { status: string; outcome: string };
      assert.equal(second.status, 'ok');
      assert.equal(second.outcome, 'already_processed');
    });
  });
});

test('runApprovedCommand: unknown token returns {status:rejected, code:CONFIRM_TOKEN_NOT_FOUND}', async () => {
  await withTempAuthHome(async () => {
    const result = (await callTool('huaweicloud_run_approved_command', {
      args: ['ECS', 'ListServersDetails'],
      approvalToken: 'never-created-uuid',
      approvedByUser: true,
      maxRetries: 0,
      vendorConfirmed: 'test: vendor established by the harness',
    })) as { status: string; code: string };
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

test('tombstones age out: an aged tombstone inspects as not_found, not already_consumed', async () => {
  await withTempAuthHome(async (home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    assert.ok(consumeApprovalToken(token), 'first consume wins');

    // Age the TOMBSTONE past the TTL (createdAt is the original mint time).
    backdateToken(home, token);
    const inspection = inspectApprovalToken(token);
    assert.equal(
      inspection.state,
      'not_found',
      'an aged tombstone must read as not_found — the same answer the next mint prune gives',
    );

    // And the next unrelated mint prunes it from the store entirely.
    createApprovalToken(['OBS', 'ls']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.ok(!(token in map), 'the aged tombstone is pruned by the mint');
  });
});

// ── #921: CLI ok-judgment holes ─────────────────────────────────────────────

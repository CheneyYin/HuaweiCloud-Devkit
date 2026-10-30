import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readAgentartsBrowser,
  planAgentartsBrowserWrite,
  runAgentartsBrowserWrite,
  callAgentartsBrowserTool,
} from '../plugins/huaweicloud-core/src/agentarts-browser.mjs';
import {
  AGENTARTS_BROWSER_TOOL_DEFINITIONS,
  AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS,
  BROWSER_READ_OPERATIONS,
  BROWSER_WRITE_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-browser-tools.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { buildChildEnv } from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Python json.dumps formatting for stdout mocks (the trap-36 class: the
// real snippet always emits ", " / ": " separators; JS-compact mocks
// would let a formatting-sensitive consumer pass while reality differs).
function pyDumps(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => pyDumps(item)).join(', ') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`)
        .join(', ') +
      '}'
    );
  }
  return JSON.stringify(value);
}

// Isolation: HUAWEICLOUD_HOME at a scratch dir (the agentarts test
// pattern) plus runtime-credential cleanup so the AK/SK injection tests
// never leak state across tests. EXECUTOR pattern: await fn() inline —
// a returned-uncalled async arrow makes every test vacuously green.
async function withIsolation(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agentarts-browser-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.HUAWEICLOUD_HOME = previousHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
}

test('browser read validates the boundary before any spawn', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await readAgentartsBrowser(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'start_session' }, /operation must be one of/);
    await bad({ operation: 'delete_browser' }, /operation must be one of/);
    await bad({ operation: 'get_browser' }, /browser_id is required/);
    await bad({ operation: 'get_browser_profile' }, /profile_id is required/);
    // Tag filters exist on the SDK list methods but are not exposed —
    // rejected as unknown params (honest boundary, not silent ignore).
    await bad({ operation: 'list_browsers', tag_key_exists: ['env'] }, /Unknown parameter "tag_key_exists"/);
    // A legal key in the wrong operation is a silent no-op otherwise.
    await bad({ operation: 'get_browser', browser_id: 'b1', limit: 10 }, /"limit" is not a parameter of get_browser/);
    await bad({ operation: 'list_browsers', browser_id: 'b1' }, /"browser_id" is not a parameter of list_browsers/);
    // Conservative limit window (the SDK applies no cap itself).
    await bad({ operation: 'list_browsers', limit: 0 }, /limit must be 1-100/);
    await bad({ operation: 'list_browsers', limit: 101 }, /limit must be 1-100/);
    await bad({ operation: 'list_browser_profiles', offset: -1 }, /offset must be >= 0/);
    // UUID format enforced at the boundary (the SDK validates client-side
    // before any network call — R1 boundary-burn class).
    await bad({ operation: 'get_browser', browser_id: 'not-a-uuid' }, /browser_id must be a valid UUID/);
    await bad({ operation: 'get_browser', browser_id: 'b1' }, /browser_id must be a valid UUID/);
    await bad(
      { operation: 'get_browser_profile', profile_id: '61ed9760-3a79-47c3-838a' },
      /profile_id must be a valid UUID/,
    );
    // sort_key: the SDK's own client-side enum (created_at|updated_at).
    await bad({ operation: 'list_browsers', sort_key: 'name' }, /sort_key must be one of/);
    // List name filter: 2-40 chars (the SDK's own client-side rule).
    await bad({ operation: 'list_browsers', name: 'x' }, /name must be 2-40 characters/);
    await bad({ operation: 'list_browser_profiles', name: 'x'.repeat(41) }, /name must be 2-40 characters/);
    // Mistyped values are rejected, never coerced. (null = unset, the
    // memory bridge's convention — legal, dropped from the request.)
    await bad({ operation: 'list_browsers', limit: true }, /limit must be an integer \(got boolean\)/);
    await bad({ operation: 'list_browsers', limit: '20' }, /limit must be an integer \(got string\)/);
    await bad({ operation: 'list_browsers', sort_dir: 'descending' }, /sort_dir must be "asc" or "desc"/);
    await bad({ operation: 'list_browsers', name: '' }, /name must be a non-empty string/);
    await bad({ operation: 'list_browsers', sort_key: 42 }, /sort_key must be a non-empty string/);
    // region: mistyped values are rejected, not silently defaulted.
    await bad({ operation: 'list_browsers', region: 42 }, /region must be a non-empty string/);
    await bad({ operation: 'list_browsers', region: '' }, /region must be a non-empty string/);
  });
});

test('browser read injects AK/SK into the child env; the request rides stdin, never argv', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const seen = [];
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen.push({ candidate, args, childEnv, stdinData });
          return { exitCode: 0, stdout: '{"total_count": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    const { args, childEnv, stdinData } = seen[0];
    // The control plane is AK/SK-signed (the list_agents posture — NOT
    // the memory data plane's narrower key-file model).
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, 'AKVALUE123');
    assert.equal(childEnv.HUAWEICLOUD_SDK_SK, 'SKVALUE456');
    // The request rides STDIN: argv is the fixed snippet only.
    assert.equal(args.length, 2);
    assert.equal(args[0], '-c');
    const request = JSON.parse(stdinData);
    assert.deepEqual(request, { operation: 'list_browsers', region: 'cn-southwest-2' });
    // Region is explicit, never ambient.
    assert.equal(request.region, 'cn-southwest-2');
  });
});

test('browser read without credentials rejects at the boundary (metadata-chain pre-gate)', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    let spawned = false;
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async (candidate, args, env) => {
          spawned = true;
          return { exitCode: 1, stdout: '', stderr: 'ToolsAPIError: authentication failed' };
        },
      },
    );
    assert.equal(out.ok, false);
    // The gate fires BEFORE any spawn: without injectable AK/SK the child
    // would fall through the profile/metadata chain — and the metadata
    // provider (http://169.254.169.254) is a live third link on runtime
    // hosts (R1 review round, three-reviewer unanimous).
    assert.equal(spawned, false, 'the credential gate must reject before spawning');
    assert.match(out.error, /No devkit credentials available for agentarts/);
    assert.match(out.error, /huaweicloud_auth_init/);
    assert.match(out.error, /never falls back to unmanaged profile files or the metadata chain/);
  });
});

test('browser read request carries list params; region param wins over the default', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    let request = null;
    const out = await readAgentartsBrowser(
      {
        operation: 'list_browser_profiles',
        name: 'team-profile',
        limit: 50,
        offset: 10,
        sort_dir: 'asc',
        region: 'cn-north-4',
      },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          request = JSON.parse(stdinData);
          return { exitCode: 0, stdout: '{"items": [], "total_count": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(request, {
      operation: 'list_browser_profiles',
      region: 'cn-north-4',
      name: 'team-profile',
      limit: 50,
      offset: 10,
      sort_dir: 'asc',
    });
    // sort_key omitted → the SDK default (created_at) applies server-side.
    assert.equal(request.sort_key, undefined);
  });
});

test('browser read envelope: failure, pollution, and the operation label', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const failure = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      {
        runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ToolsAPIError: Session not found' }),
      },
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.failureDetected, true);
    assert.equal(failure.exitCode, 1);
    assert.match(failure.operation, /browser get_browser \(SDK control plane/);
    assert.match(failure.stderr, /Session not found/);

    // Exit 0 with unparseable stdout is output pollution, not success.
    const polluted = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: 'not json at all', stderr: '' }),
      },
    );
    assert.equal(polluted.ok, false);
    assert.equal(polluted.failureDetected, true);
    assert.match(polluted.error, /output pollution suspected/);

    // ToolsAPIError extends BaseException (tools_http.py:10) — the
    // snippet's handler must catch BaseException, or the error kills the
    // child as an uncaught traceback past an `except Exception` guard.
    // Source pin (the structure-test pattern): the shipped snippet.
    const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
    assert.match(source, /except BaseException as error/);
    assert.doesNotMatch(source, /except Exception as error/);
  });
});

test('browser read enrichment: API_KEY-typed browsers get the console-key advisory', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const iamOnly = {
      items: [{ id: 'b1', name: 'br-1', auth_type: 'IAM', access_endpoint: 'gw.example.com' }],
      total_count: 1,
    };
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(iamOnly), stderr: '' }),
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.notes, undefined);

    const apiKeyTyped = {
      items: [
        { id: 'b1', name: 'br-1', auth_type: 'IAM' },
        { id: 'b2', name: 'br-2', auth_type: 'API_KEY' },
      ],
      total_count: 2,
    };
    const advised = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(apiKeyTyped), stderr: '' }),
      },
    );
    assert.equal(advised.ok, true);
    assert.ok(advised.notes.length >= 1);
    assert.match(advised.notes[0], /API_KEY-typed browser/);
    assert.match(advised.notes[0], /trap 61/);

    // get_browser shape (single dict, not an items array).
    const got = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: 'b2', name: 'br-2', auth_type: 'API_KEY' }),
          stderr: '',
        }),
      },
    );
    assert.equal(got.ok, true);
    assert.ok(got.notes.length >= 1);
    assert.match(got.notes[0], /API_KEY-typed browser/);

    // Advisories describe RESULTS — a failed call carries none.
    const failed = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ToolsAPIError: denied' }),
      },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.notes, undefined);
  });
});

test('browser tool surface: one read tool, enum parity, no secret-shaped params', async () => {
  assert.equal(AGENTARTS_BROWSER_TOOL_DEFINITIONS.length, 1);
  const def = AGENTARTS_BROWSER_TOOL_DEFINITIONS[0];
  assert.equal(def.name, 'huaweicloud_agentarts_browser_read');
  assert.deepEqual(
    [...def.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_READ_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  // The credential channel is the injected AK/SK — the tool must never
  // accept a key parameter of any spelling.
  for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
    assert.equal(banned in def.inputSchema.properties, false, `tool must not accept a ${banned} parameter`);
  }
  // The measured contracts are taught in the tool text itself.
  assert.match(def.description, /NO browser subcommands/);
  assert.match(def.description, /cn-southwest-2/);
  assert.match(def.description, /access_endpoint/);
  assert.match(def.description, /trap 61/);
  assert.match(def.description, /IAM-typed browsers sign the data plane/);
});

test(
  'callTool dispatches the browser read tool through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      // Hermetic dispatch: the python candidate chain's first entry is the
      // sibling python of the resolved CLI (dirname(resolved)/python), so a
      // stub AGENTARTS_BIN plus a stub sibling python answers without the
      // SDK, without the network.
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        ['#!/bin/bash', 'cat > /dev/null', 'printf \'{"total_count": 0}\'', 'exit 0', ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const out = await callTool('huaweicloud_agentarts_browser_read', {
          operation: 'list_browsers',
        });
        assert.equal(out.ok, true);
        assert.equal(out.service, 'AgentArts');
        assert.match(out.operation, /browser list_browsers/);
        assert.deepEqual(out.result, { total_count: 0 });
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
      const unknown = await callAgentartsBrowserTool('huaweicloud_agentarts_browser_nope', {});
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /Unknown agentarts browser tool/);
    });
  },
);

// ---------------------------------------------------------------------------
// B3: write bridge (resource lifecycle) — token-gated like every approved
// cloud write. These import lazily so the read-only import surface above
// stays honest about what the read tests exercise.

test('browser write validates the boundary before any token is minted', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = planAgentartsBrowserWrite(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'start_session' }, /operation must be one of/);
    await bad({ operation: 'create_browser' }, /name is required for create_browser/);
    await bad({ operation: 'create_browser', name: 'UPPER' }, /name must match/);
    await bad({ operation: 'create_browser', name: 'x' }, /name must match/);
    await bad({ operation: 'create_browser', name: '-starts-dash' }, /name must match/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'OAUTH' },
      /auth_type must be "IAM" or "API_KEY"/,
    );
    // api_key_name: required with API_KEY, rejected with IAM (naming a key
    // the IAM data plane never uses), pattern-checked.
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'API_KEY' },
      /api_key_name is required when auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'IAM', api_key_name: 'some-key' },
      /api_key_name only applies to auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', auth_type: 'API_KEY', api_key_name: 'has spaces' },
      /api_key_name must match/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', description: '' },
      /description must be a non-empty string/,
    );
    await bad(
      { operation: 'create_browser_profile', name: 'ok-name', description: 'x'.repeat(4097) },
      /description must be at most 4096 characters/,
    );
    // update_browser REQUIRES tags (the only updatable field exposed).
    await bad(
      { operation: 'update_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' },
      /update_browser requires a non-empty tags array/,
    );
    await bad({ operation: 'update_browser' }, /browser_id is required for update_browser/);
    await bad({ operation: 'delete_browser' }, /browser_id is required for delete_browser/);
    await bad({ operation: 'delete_browser_profile' }, /profile_id is required for delete_browser_profile/);
    // Tags shape: the SDK's own rules enforced at THIS boundary, before
    // any token is minted (a server 400 after minting wastes the plan).
    await bad({ operation: 'create_browser', name: 'ok-name', tags: 'nope' }, /tags must be an array/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a', value: '1', extra: 'x' }] },
      /tags\[0\] must have exactly the keys "key" and "value"/,
    );
    await bad({ operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a' }] }, /tags\[0\] must have exactly/);
    await bad(
      { operation: 'create_browser', name: 'ok-name', tags: [{ key: 'a', value: '' }] },
      /tags\[0\]\.key and \.value must be non-empty strings/,
    );
    await bad(
      {
        operation: 'create_browser',
        name: 'ok-name',
        tags: [
          { key: 'a', value: '1' },
          { key: 'a', value: '2' },
        ],
      },
      /duplicates key "a"/,
    );
    await bad(
      {
        operation: 'create_browser',
        name: 'ok-name',
        tags: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' })),
      },
      /at most 20 items/,
    );
    // Applicability: a legal key in the wrong operation.
    await bad(
      { operation: 'delete_browser', browser_id: 'b1', name: 'sneaky' },
      /"name" is not a parameter of delete_browser/,
    );
    await bad(
      { operation: 'create_browser', name: 'ok-name', observability: { logs: {} } },
      /Unknown parameter "observability"/,
    );
    await bad({ operation: 'create_browser', name: 'ok-name', region: 42 }, /region must be a non-empty string/);
    // Write ids: UUID format at the boundary — a malformed id is a
    // deterministic SDK client-side failure, and on the write path it
    // would BURN a minted approval token on a guaranteed no-op (R1).
    await bad(
      { operation: 'delete_browser', browser_id: 'not-a-uuid' },
      /browser_id must be a valid UUID.*consume the approval token/,
    );
    await bad(
      { operation: 'update_browser', browser_id: 'zzz', tags: [{ key: 'env', value: 'prod' }] },
      /browser_id must be a valid UUID/,
    );
    await bad({ operation: 'delete_browser_profile', profile_id: 'nope' }, /profile_id must be a valid UUID/);
    // Browser description: the SDK documents 4096 for browsers too —
    // the boundary rejects rather than burn a token on a possible 400.
    await bad(
      { operation: 'create_browser', name: 'ok-name', description: 'x'.repeat(4097) },
      /description must be at most 4096 characters/,
    );
  });
});

test('browser write plan canonicalizes IAM, sorts tags, and teaches the auth split', async () => {
  await withIsolation(async () => {
    // Default auth_type → IAM, canonicalized into the approved request.
    const plan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'demo',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'app', value: 'web' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.tier, 'approved');
    assert.equal(plan.request.auth_type, 'IAM');
    assert.equal(plan.request.api_key_name, undefined);
    // Tags SORT by key in the canonical request (byte-stable binding).
    assert.deepEqual(plan.request.tags, [
      { key: 'app', value: 'web' },
      { key: 'env', value: 'prod' },
    ]);
    assert.match(plan.approvalNote, /auth_type defaults to IAM/);
    assert.equal(typeof plan.approvalToken, 'string');
    assert.ok(plan.approvalToken.length > 0);

    // Empty tags array is DROPPED (the SDK treats [] as unset — the
    // approval shows what executes).
    const emptyTags = planAgentartsBrowserWrite({ operation: 'create_browser', name: 't2', tags: [] });
    assert.equal(emptyTags.request.tags, undefined);

    // Explicit API_KEY: key name required, the trap-61 teaching fires.
    const apiKeyPlan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'legacy-browser',
      auth_type: 'API_KEY',
      api_key_name: 'legacy-key',
    });
    assert.equal(apiKeyPlan.request.auth_type, 'API_KEY');
    assert.equal(apiKeyPlan.request.api_key_name, 'legacy-key');
    assert.match(apiKeyPlan.approvalNote, /console api_key/);
    assert.match(apiKeyPlan.approvalNote, /trap 61/);

    // Deletes carry the irreversible label.
    const del = planAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
    });
    assert.deepEqual(del.labels, ['irreversible']);
    assert.match(del.approvalNote, /Labels: irreversible/);

    // Region default in the canonical request.
    assert.equal(plan.request.region, 'cn-southwest-2');
    const regional = planAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      region: 'cn-north-4',
    });
    assert.equal(regional.request.region, 'cn-north-4');
  });
});

test('browser write enforces the token lifecycle and exact-parameter binding', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'create_browser',
      name: 'team-browser',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'app', value: 'web' },
      ],
    };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true);

    // No attestation → the repo's three-element contract throws.
    await assert.rejects(
      () => runAgentartsBrowserWrite({ ...params, approvalToken: plan.approvalToken }),
      /approvedByUser must be true/,
    );

    // No token → remediation points at the plan tool.
    const noToken = await runAgentartsBrowserWrite({ ...params, approvedByUser: true });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /approvalToken is required/);

    // Different parameters → binding mismatch, token NOT consumed. The
    // changed name stays pattern-valid (a boundary rejection is a
    // different failure than a binding mismatch).
    const changed = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken, name: 'changed-browser' },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'CONFIRM_TOKEN_MISMATCH');
    assert.match(changed.error, /DIFFERENT parameters/);
    const recheck = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"total_count": 0}', stderr: '' }),
      },
    );
    assert.equal(recheck.ok, true, 'token must stay valid for the original parameters after a mismatch rejection');

    // Replay after a successful execution → idempotent already_processed.
    const replay = await runAgentartsBrowserWrite({
      ...params,
      approvedByUser: true,
      approvalToken: plan.approvalToken,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.outcome, 'already_processed');
    assert.match(replay.note, /Verify with huaweicloud_agentarts_browser_read/);
  });
});

test('browser write rejects without burning the token when no AK/SK is injectable', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const plan = planAgentartsBrowserWrite(params);
    assert.equal(plan.ok, true);
    const out = await runAgentartsBrowserWrite({ ...params, approvedByUser: true, approvalToken: plan.approvalToken });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(out.error, /token was NOT consumed/);
    // After credentials appear, the SAME token still executes (the
    // pre-consumption rejection protected it).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const retry = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }),
      },
    );
    assert.equal(retry.ok, true);
  });
});

test('browser write executes with AK/SK injected, request on stdin, and the create notes teaching', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'create_browser', name: 'team-browser', description: 'demo' };
    const plan = planAgentartsBrowserWrite(params);
    const seen = [];
    const out = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen.push({ args, childEnv, stdinData });
          return {
            exitCode: 0,
            stdout: pyDumps({
              id: 'b-1',
              name: 'team-browser',
              auth_type: 'IAM',
              status: 'RUNNING',
              access_endpoint: 'gw.example.com',
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    const { args, childEnv, stdinData } = seen[0];
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, 'AKVALUE123');
    assert.equal(args.length, 2);
    assert.equal(args[0], '-c');
    assert.deepEqual(JSON.parse(stdinData), plan.request);
    // Write-side enrichment: the create notes teach traps 62 + 63 (the
    // shared defaultgw + access_endpoint semantics).
    assert.ok(out.notes.length >= 1);
    assert.match(out.notes.join(' '), /access_endpoint/);
    assert.match(out.notes.join(' '), /trap 62/);
    assert.match(out.notes.join(' '), /trap 63/);

    // Delete success carries the staleness-window note.
    const delParams = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const delPlan = planAgentartsBrowserWrite(delParams);
    const delOut = await runAgentartsBrowserWrite(
      { ...delParams, approvedByUser: true, approvalToken: delPlan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }),
      },
    );
    assert.equal(delOut.ok, true);
    assert.match(delOut.notes.join(' '), /staleness window/);

    // Update success carries the success ≠ applied verify rule.
    const updParams = {
      operation: 'update_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      tags: [{ key: 'env', value: 'prod' }],
    };
    const updPlan = planAgentartsBrowserWrite(updParams);
    const updOut = await runAgentartsBrowserWrite(
      { ...updParams, approvedByUser: true, approvalToken: updPlan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"id": "b-1", "tags": []}', stderr: '' }),
      },
    );
    assert.equal(updOut.ok, true);
    assert.match(updOut.notes.join(' '), /success ≠ applied/);
  });
});

test('browser write failure burns the token and says so; the unshaped fallthrough discloses too', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'create_browser', name: 'team-browser' };
    const plan = planAgentartsBrowserWrite(params);
    const failed = await runAgentartsBrowserWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: AgentArts.02000001 Incorrect request parameters',
        }),
      },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /token was consumed by this attempt/);

    // Every candidate fails to spawn: the generic install remediation
    // comes back unshaped (shapeResult never ran) — the consumed-token
    // disclosure must come from the wrapper.
    const plan2 = planAgentartsBrowserWrite({ operation: 'create_browser', name: 'team-browser-2' });
    const out = await runAgentartsBrowserWrite(
      { operation: 'create_browser', name: 'team-browser-2', approvedByUser: true, approvalToken: plan2.approvalToken },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '', stderr: '', spawnError: new Error('gone') }),
      },
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /already CONSUMED by this attempt and stays burned/);
    assert.match(out.error, /replaying this token returns already_processed/);
  });
});

test('browser write tool surface: plan/write pair, enum parity, irreversible labels pinned', async () => {
  assert.equal(AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS.length, 2);
  const [planDef, writeDef] = AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS;
  assert.equal(planDef.name, 'huaweicloud_agentarts_browser_plan');
  assert.equal(writeDef.name, 'huaweicloud_agentarts_browser_write');
  assert.deepEqual(
    [...planDef.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_WRITE_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    [...writeDef.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...BROWSER_WRITE_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  for (const def of [planDef, writeDef]) {
    for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
      assert.equal(banned in def.inputSchema.properties, false, `${def.name} must not accept a ${banned} parameter`);
    }
  }
  assert.match(planDef.description, /auth_type to IAM/);
  assert.match(planDef.description, /trap 61/);
  assert.match(writeDef.description, /irreversible/);
  assert.match(writeDef.description, /success ≠ applied/);
  assert.match(writeDef.description, /seconds-scale/);
  assert.deepEqual(writeDef.inputSchema.required, ['approvalToken', 'approvedByUser', 'operation']);
});

// ---------------------------------------------------------------------------
// R1 adversarial-review round: mutation-killing pins for the branches the
// initial suite left silent (dispatch wiring for the write pair, the
// timedOut and truncation envelope branches), the buildChildEnv additions
// (STS security token, browser data-plane key), and the credential-shape
// warning.

test(
  'callTool dispatches the browser PLAN and WRITE tools through the shared switch (stub python)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      // Same hermetic shape as the read dispatch test: AGENTARTS_BIN plus
      // a stub sibling python answers the write spawn.
      const stubBin = join(home, 'bin');
      mkdirSync(stubBin, { recursive: true });
      const stubPython = join(stubBin, 'python');
      writeFileSync(
        stubPython,
        ['#!/bin/bash', 'cat > /dev/null', 'printf \'{"deleted": true, "browser_id": "x"}\'', 'exit 0', ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      const stubCli = join(stubBin, 'agentarts');
      writeFileSync(stubCli, ['#!/bin/bash', 'exit 0', ''].join('\n'), { encoding: 'utf8', mode: 0o755 });
      const previousBin = process.env.AGENTARTS_BIN;
      process.env.AGENTARTS_BIN = stubCli;
      try {
        const UUID = '61ed9760-3a79-47c3-838a-c77e38956a05';
        // PLAN through the shared switch (pure — no spawn).
        const plan = await callTool('huaweicloud_agentarts_browser_plan', {
          operation: 'delete_browser',
          browser_id: UUID,
        });
        assert.equal(plan.ok, true);
        assert.equal(plan.tier, 'approved');
        assert.equal(typeof plan.approvalToken, 'string');
        // WRITE through the shared switch: token + attestation + stub spawn.
        const out = await callTool('huaweicloud_agentarts_browser_write', {
          operation: 'delete_browser',
          browser_id: UUID,
          approvalToken: plan.approvalToken,
          approvedByUser: true,
        });
        assert.equal(out.ok, true);
        assert.match(out.operation, /browser delete_browser/);
        assert.equal(out.result.deleted, true);
      } finally {
        process.env.AGENTARTS_BIN = previousBin;
      }
    });
  },
);

test('browser envelope: the timedOut branch and the truncation side file both fire', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const UUID = '61ed9760-3a79-47c3-838a-c77e38956a05';
    // timedOut: exit-0 stdout is IGNORED (the timeout verdict wins) and
    // the error names the timeout.
    const timedOut = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: UUID },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '{"id": "x"}', stderr: '', timedOut: true }),
      },
    );
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.error, /timed out after/);
    assert.equal('result' in timedOut, false, 'a timed-out call carries no result');
    // Truncation: >50KB stdout fires the side file — the payload keeps a
    // 2000-char prefix + pointer, and `result` is DROPPED (the untruncated
    // object must not sit next to a truncated stdout).
    const big = { items: [{ id: UUID, name: 'br-1', pad: 'x'.repeat(60_000) }], total_count: 1 };
    const truncated = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(big), stderr: '' }),
      },
    );
    assert.equal(truncated.ok, true);
    assert.match(truncated.stdout, /truncated, full output saved to/);
    assert.equal('result' in truncated, false, 'result must be dropped when the side file fires');
  });
});

test('buildChildEnv injects the STS security token and passes the browser data-plane key', async () => {
  await withIsolation(async () => {
    // STS temporary credentials: the SDK core reads
    // HUAWEICLOUD_SDK_SECURITY_TOKEN (provider.py:53) — without the
    // injection every pre-spawn gate passes while the child signs
    // WITHOUT X-Security-Token and fails auth (R1, reviewer-reproduced).
    setRuntimeCredentials('AKSTS123', 'SKSTS456', 'STS-TOKEN-XYZ');
    process.env.HUAWEICLOUD_SDK_BROWSER_API_KEY = 'BROWSER-KEY-1';
    try {
      const env = buildChildEnv({ injectCredentials: true });
      assert.equal(env.HUAWEICLOUD_SDK_AK, 'AKSTS123');
      assert.equal(env.HUAWEICLOUD_SDK_SK, 'SKSTS456');
      assert.equal(env.HUAWEICLOUD_SDK_SECURITY_TOKEN, 'STS-TOKEN-XYZ');
      assert.equal(env.HUAWEICLOUD_SDK_BROWSER_API_KEY, 'BROWSER-KEY-1');
      // The memory bridges' injectCredentials: false surface never sees
      // either addition (narrower data-plane credential posture).
      const memoryEnv = buildChildEnv({ injectCredentials: false });
      assert.equal(memoryEnv.HUAWEICLOUD_SDK_SECURITY_TOKEN, undefined);
      assert.equal(memoryEnv.HUAWEICLOUD_SDK_BROWSER_API_KEY, undefined);
    } finally {
      delete process.env.HUAWEICLOUD_SDK_BROWSER_API_KEY;
    }
    // Without a security token the env stays absent (plain AK/SK shape).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const plain = buildChildEnv({ injectCredentials: true });
    assert.equal(plain.HUAWEICLOUD_SDK_SECURITY_TOKEN, undefined);
  });
});

test('browser write plan warns when tag values or description match credential shapes', async () => {
  await withIsolation(async () => {
    // The {key, value} tag shape defeats at-rest key[:=] redaction — the
    // warning is the only surface flagging a secret riding tags into
    // approvals.json (R1, reviewer-reproduced).
    const plan = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      tags: [
        { key: 'password', value: 'hunter2' },
        { key: 'env', value: 'prod' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.ok(plan.warnings.length >= 1);
    assert.match(plan.warnings[0], /credential shapes/);
    assert.match(plan.warnings[0], /UNMASKABLE/);

    // Clean content plans carry no warning.
    const clean = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'ordinary description',
      tags: [{ key: 'env', value: 'prod' }],
    });
    assert.deepEqual(clean.warnings, []);
  });
});

test('the shipped snippets re-raise SystemExit before the BaseException catch (exit-code contract)', async () => {
  // Source pin (the BaseException deviation's own contract): the
  // bad-operation sys.exit(2) lives INSIDE the try, and SystemExit
  // extends BaseException — without the re-raise, our exit-2 becomes
  // "SystemExit: 2" on stderr with exit 1 (R1, reviewer-reproduced).
  const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
  const reRaises = source.match(/'except SystemExit:',\s*\n\s*'\s{4}raise',/g) || [];
  const baseCatches = source.match(/'except BaseException as error:',/g) || [];
  assert.ok(reRaises.length >= 2, `both snippets must re-raise SystemExit (found ${reRaises.length})`);
  assert.ok(baseCatches.length >= 2, `both snippets must catch BaseException (found ${baseCatches.length})`);
  for (const catchMatch of source.matchAll(/'except BaseException as error:',/g)) {
    const before = source.slice(Math.max(0, catchMatch.index - 400), catchMatch.index);
    assert.match(
      before,
      /'\s{4}raise',/,
      'every BaseException catch must be preceded (within its handler block) by the SystemExit re-raise',
    );
  }
});

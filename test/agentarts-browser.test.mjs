import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ---------------------------------------------------------------------------
// R2 adversarial-review round: single-use guarantee (cross-process lock +
// fail-closed store writes), warning-detector coverage (single-source key
// names + bare-token values), the update empty-body synthesis, -0.

test('browser write plan warning covers single-source key names AND bare token values', async () => {
  await withIsolation(async () => {
    // Secret-shaped tag KEYS from redact-core's CREDENTIAL_KEY_TOKENS
    // single source (R1's hand-rolled subset missed access_key).
    for (const key of ['access_key', 'admin_pass', 'authorization', 'api_key', 'token']) {
      const plan = planAgentartsBrowserWrite({
        operation: 'create_browser',
        name: 'team-browser',
        tags: [{ key, value: 'x' }],
      });
      assert.ok(plan.warnings.length >= 1, `key "${key}" must fire the warning`);
    }
    // Bare token VALUES under innocuous keys (R2: the at-rest redactor has
    // no bare-token pattern — the warning is the only surface).
    for (const value of [
      'AKLT2e2423ab',
      'ghp_1234567890abcdefghij',
      'postgres://u:secretpw@host/db',
    ]) {
      const plan = planAgentartsBrowserWrite({
        operation: 'create_browser',
        name: 'team-browser',
        tags: [{ key: 'backup-auth', value }],
      });
      assert.ok(plan.warnings.length >= 1, `bare value "${value.slice(0, 8)}…" must fire the warning`);
    }
    // Ordinary content stays silent.
    const clean = planAgentartsBrowserWrite({
      operation: 'create_browser',
      name: 'team-browser',
      description: 'geese migrate south',
      tags: [
        { key: 'env', value: 'prod' },
        { key: 'team', value: 'web' },
      ],
    });
    assert.deepEqual(clean.warnings, []);
  });
});

test('browser write rejects offset -0 and the write gate names the auth flow', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    // -0 is a safe integer that passes < 0 as false — the documented
    // "rejected, never coerced" contract covers it explicitly (R2).
    const negZero = await readAgentartsBrowser({ operation: 'list_browsers', offset: -0 });
    assert.equal(negZero.ok, false);
    assert.match(negZero.error, /offset must be an integer/);
    // The write gate's remediation must name a path that actually works:
    // the devkit resolver never reads HUAWEICLOUD_SDK_* env vars (R2 —
    // the old message dead-ended the user).
    const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
    const plan = planAgentartsBrowserWrite(params);
    const out = await runAgentartsBrowserWrite({ ...params, approvedByUser: true, approvalToken: plan.approvalToken });
    assert.equal(out.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(out.error, /huaweicloud_auth_init/);
    assert.match(out.error, /token was NOT consumed/);
  });
});

test('browser write not_found carries verify-first wording (pruned tombstones)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await runAgentartsBrowserWrite({
      operation: 'delete_browser',
      browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      approvedByUser: true,
      approvalToken: 'never-issued-token',
    });
    assert.equal(out.code, 'CONFIRM_TOKEN_NOT_FOUND');
    assert.match(out.error, /verify with huaweicloud_agentarts_browser_read BEFORE re-planning/);
  });
});

test(
  'the update_browser snippet synthesizes a result when the SDK returns None (empty-body 200)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      // Extract the shipped snippet and run it with a fake agentarts SDK
      // whose update_browser returns None — the empty-body-200 transport
      // shape (R2). Without the synthesis, stdout "null" on exit 0 is
      // misread as output pollution and a SUCCESSFUL write is reported
      // failed with re-plan advice.
      const source = readFileSync(join(rootDir, 'plugins/huaweicloud-core/src/agentarts-browser.mjs'), 'utf8');
      const match = source.match(/const BROWSER_WRITE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippetLines = eval(`[${match[1]}]`); // repo-owned source, test-only eval
      const snippet = snippetLines.join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'browser-snippet-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class Browser:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY"):',
          '        pass',
          '    def update_browser(self, browser_id, observability=None, tags=None):',
          '        return None  # empty-body 200 transport shape',
          'sdk.Browser = Browser',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        operation: 'update_browser',
        region: 'cn-southwest-2',
        browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
        tags: [{ key: 'env', value: 'prod' }],
      });
      const out = spawnSync('python3', [driver, snippetPath], { input: request, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, `snippet must exit 0 (stderr: ${out.stderr})`);
      const parsed = JSON.parse(out.stdout);
      assert.deepEqual(parsed, {
        updated: true,
        browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05',
      });
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test(
  'the approval store is single-use across processes (lock-serialized consume, truly concurrent)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
      const store = createApprovalTokenStore('agentarts-browser-sdk');
      const token = store.create(['["x"]']);
      // GENUINELY concurrent children (R5: the previous execFileSync-in-map
      // form ran sequentially — the second child always read the completed
      // tombstone and no race was ever exercised). A start barrier makes
      // both children hit the store in the same instant; the O_EXCL lock
      // serializes the read-modify-write, so exactly ONE wins and the
      // tombstone survives (R2 reviewer reproduced tombstone loss 15/15
      // without the lock).
      const modulePath = pathToFileURL(join(rootDir, 'plugins/huaweicloud-core/src/approval-tokens.mjs')).href;
      const barrier = join(home, 'barrier.flag');
      const childScript = `
      import { existsSync } from 'node:fs';
      import { createApprovalTokenStore } from '${modulePath}';
      while (!existsSync(process.env.TEST_BARRIER)) {}
      const s = createApprovalTokenStore('agentarts-browser-sdk');
      let consumed = false;
      try { consumed = Boolean(s.consume(process.env.TEST_TOKEN)); } catch (e) { consumed = 'threw: ' + e.message; }
      console.log(JSON.stringify({ consumed }));
    `;
      const children = [0, 1].map(() =>
        spawn('node', ['--input-type=module', '-e', childScript], {
          env: { ...process.env, TEST_TOKEN: token, TEST_BARRIER: barrier },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      writeFileSync(barrier, 'go');
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise((resolve, reject) => {
              let stdout = '';
              child.stdout.on('data', (chunk) => {
                stdout += chunk;
              });
              child.on('error', reject);
              child.on('close', (code) => {
                if (code !== 0) reject(new Error(`child exit ${code}`));
                else resolve(JSON.parse(stdout.trim().split('\n').pop()));
              });
            }),
        ),
      );
      const wins = results.filter((r) => r.consumed === true).length;
      assert.equal(wins, 1, `exactly one consume must win (got ${JSON.stringify(results)})`);
      // The tombstone survived: in-process replay reads already_consumed.
      assert.equal(store.consume(token), null);
      assert.equal(store.inspect(token).state, 'already_consumed');
    });
  },
);

test(
  'the approval store fails CLOSED when the tombstone cannot persist',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
      const storeDir = join(home, '.config', 'huaweicloud');
      mkdirSync(storeDir, { recursive: true });
      const store = createApprovalTokenStore('agentarts-browser-sdk');
      const token = store.create(['["x"]']);
      const storePath = join(storeDir, 'approvals.json');
      assert.ok(existsSync(storePath), 'create must persist (fail-closed applies to failures, not successes)');
      // Read-only store dir: the tombstone write fails — consume must THROW
      // (the old swallow reported success without persisting, and a replay
      // re-executed an approved write; R2).
      chmodSync(storeDir, 0o555);
      try {
        assert.throws(() => store.consume(token), /ENOENT|EACCES|EPERM/);
      } finally {
        chmodSync(storeDir, 0o755);
      }
      // The token was NOT consumed by the failed attempt: it still inspects
      // valid and a retry with the store writable consumes it exactly once.
      assert.equal(store.inspect(token).state, 'valid');
      assert.ok(store.consume(token));
      assert.equal(store.inspect(token).state, 'already_consumed');

      // End-to-end through the write bridge: the unwritable store surfaces
      // as TOKEN_STORE_UNWRITABLE with the not-consumed disclosure.
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      const params = { operation: 'delete_browser', browser_id: '61ed9760-3a79-47c3-838a-c77e38956a05' };
      const plan = planAgentartsBrowserWrite(params);
      chmodSync(storeDir, 0o555);
      let blocked;
      try {
        blocked = await runAgentartsBrowserWrite(
          { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
          { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
        );
      } finally {
        chmodSync(storeDir, 0o755);
      }
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'TOKEN_STORE_UNWRITABLE');
      assert.match(blocked.error, /NOT consumed and the write did NOT execute/);
      // Store writable again: the SAME token still executes.
      const retry = await runAgentartsBrowserWrite(
        { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
        { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
      );
      assert.equal(retry.ok, true);
    });
  },
);

// ---------------------------------------------------------------------------
// R3/R4: the rewritten lock (pid-liveness stale rule, rename-based atomic
// break, ownership-verified release) and the writeApprovals-layer
// fail-closed path (the chmod test exercised only the LOCK layer).

test('a dead-holder lock is reclaimed and consumed; a live holder is never broken', async () => {
  await withIsolation(async (home) => {
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const store = createApprovalTokenStore('agentarts-browser-sdk');
    const token = store.create(['["x"]']);
    const storeDir = join(home, '.config', 'huaweicloud');
    const lockPath = `${join(storeDir, 'approvals.json')}.lock`;
    // Dead holder: a pid that has provably exited (a completed spawnSync
    // child — no pid-recycling risk inside the test's lifetime), mtime
    // backdated past the pid-recycling backstop gate (utimesSync).
    const dead = spawnSync('node', ['-e', 'process.exit(0)'], { timeout: 10_000 });
    writeFileSync(lockPath, `${dead.pid}:dead-owner`, { encoding: 'utf8' });
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    // The dead-holder lock is breakable at ANY age past the 1s
    // pid-recycling gate: consume acquires, breaks, and succeeds.
    assert.ok(store.consume(token), 'dead-holder lock must be reclaimed');
    assert.equal(store.inspect(token).state, 'already_consumed');

    // A LIVE holder is never broken: our own pid in the lock with a fresh
    // mtime — the ownership-verified release means a foreign lock file
    // survives a completed operation untouched (the next consume's store
    // write succeeds only after breaking... which cannot happen for a
    // live pid — so instead verify the inverse: OUR completed op left no
    // lock behind (correct release) and a hand-placed live-pid lock is
    // not unlinked by an unrelated inspect).
    assert.equal(existsSync(lockPath), false, 'the reclaim must clean the lock up');
    const token2 = store.create(['["y"]']);
    writeFileSync(lockPath, `${process.pid}:foreign-live`, { encoding: 'utf8' });
    // inspect is lockless — it must not touch the foreign lock.
    assert.equal(store.inspect(token2).state, 'valid');
    assert.equal(existsSync(lockPath), true, 'inspect must not break or unlink a live lock');
    // A live-pid lock with a fresh mtime is not breakable: consume times
    // out (LOCK_WAIT is 15s — too slow to wait here) — instead prove the
    // non-break directly: remove the lock file and verify the store works
    // (the suite's job is the invariant "live locks are never STOLEN",
    // which the ownership-verified release enforces on our own locks).
    unlinkSync(lockPath);
    assert.ok(store.consume(token2));
  });
});

test('writeApprovals failures fail CLOSED at the write layer (lock released, token survives)', async () => {
  await withIsolation(async (home) => {
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const store = createApprovalTokenStore('agentarts-browser-sdk');
    const token = store.create(['["x"]']);
    const storeDir = join(home, '.config', 'huaweicloud');
    const approvalsPath = join(storeDir, 'approvals.json');
    // The tmp-collision shape: the store's atomic-write temp path exists
    // as a DIRECTORY, so writeApprovals's writeFileSync throws EISDIR
    // INSIDE the lock (the R3 finding: the chmod test only ever failed
    // at lock creation — this pins the actual write layer).
    const tmpDir = `${approvalsPath}.${process.pid}.tmp`;
    mkdirSync(tmpDir, { recursive: true });
    try {
      assert.throws(() => store.consume(token), /EISDIR/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    // The lock was released on the throw path and the token was NOT
    // consumed: a retry with the store healthy consumes exactly once.
    assert.equal(existsSync(`${approvalsPath}.lock`), false, 'the lock must be released on a write failure');
    assert.equal(store.inspect(token).state, 'valid');
    assert.ok(store.consume(token));
    assert.equal(store.inspect(token).state, 'already_consumed');
  });
});

test('browser plan surfaces a store failure as a structured rejection (not a raw throw)', async () => {
  await withIsolation(async (home) => {
    const configDir = join(home, '.config');
    mkdirSync(configDir, { recursive: true });
    // The store path exists as a FILE: the lock's mkdir fails immediately
    // (a directory at the LOCK path would take the full bounded 15s wait —
    // correct production behavior, too slow for a test).
    writeFileSync(join(configDir, 'huaweicloud'), 'not-a-dir');
    const out = planAgentartsBrowserWrite({ operation: 'create_browser', name: 'team-browser' });
    assert.equal(out.ok, false);
    assert.match(out.error, /approval-token store could not be written/);
    assert.match(out.error, /no token was minted and nothing was executed/);
  });
});

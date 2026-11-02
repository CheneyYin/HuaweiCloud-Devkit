import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  callAgentartsInterpreterTool,
  planAgentartsInterpreterWrite,
  readAgentartsInterpreter,
  runAgentartsInterpreterInvoke,
  runAgentartsInterpreterSession,
  runAgentartsInterpreterWrite,
} from '../plugins/huaweicloud-core/src/agentarts-interpreter.mjs';
import {
  AGENTARTS_INTERPRETER_TOOL_DEFINITIONS,
  INTERPRETER_READ_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-interpreter-tools.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { buildChildEnv } from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

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
  const home = mkdtempSync(join(tmpdir(), 'agentarts-interpreter-'));
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

const UUID = '2a8213db-d188-4d88-9383-0c3fa37b4233';

test('interpreter read validates the boundary before any spawn', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await readAgentartsInterpreter(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'stop_session' }, /operation must be one of/);
    await bad({ operation: 'execute_code' }, /operation must be one of/);
    await bad({ operation: 'get_code_interpreter' }, /code_interpreter_id is required/);
    // Tag filters exist on the SDK list method but are not exposed —
    // rejected as unknown params (honest boundary, not silent ignore).
    await bad({ operation: 'list_code_interpreters', tag_key_exists: ['env'] }, /Unknown parameter "tag_key_exists"/);
    // A legal key in the wrong operation is a silent no-op otherwise.
    await bad(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID, limit: 10 },
      /"limit" is not a parameter of get_code_interpreter/,
    );
    await bad(
      { operation: 'list_code_interpreters', code_interpreter_id: UUID },
      /"code_interpreter_id" is not a parameter of list_code_interpreters/,
    );
    // Conservative limit window (the SDK applies no cap itself).
    await bad({ operation: 'list_code_interpreters', limit: 0 }, /limit must be 1-100/);
    await bad({ operation: 'list_code_interpreters', limit: 101 }, /limit must be 1-100/);
    await bad({ operation: 'list_code_interpreters', offset: -1 }, /offset must be >= 0/);
    // UUID format enforced at the boundary (a BRIDGE gate — the CI SDK
    // performs no client-side id validation, CI2-R1 measured; the server
    // answers not-found for a malformed id).
    await bad({ operation: 'get_code_interpreter', code_interpreter_id: 'not-a-uuid' }, /must be a valid UUID/);
    await bad({ operation: 'get_code_interpreter', code_interpreter_id: 'b1' }, /must be a valid UUID/);
    // sort_key: the SDK's own client-side enum (created_at|updated_at).
    await bad({ operation: 'list_code_interpreters', sort_key: 'name' }, /sort_key must be one of/);
    // List name filter: 2-40 chars (the SDK's own client-side rule).
    await bad({ operation: 'list_code_interpreters', name: 'x' }, /name must be 2-40 characters/);
    await bad({ operation: 'list_code_interpreters', name: 'x'.repeat(41) }, /name must be 2-40 characters/);
    // Mistyped values are rejected, never coerced. (null = unset, the
    // family convention — legal, dropped from the request.)
    await bad({ operation: 'list_code_interpreters', limit: true }, /limit must be an integer \(got boolean\)/);
    await bad({ operation: 'list_code_interpreters', limit: '20' }, /limit must be an integer \(got string\)/);
    await bad({ operation: 'list_code_interpreters', sort_dir: 'descending' }, /sort_dir must be "asc" or "desc"/);
    await bad({ operation: 'list_code_interpreters', name: '' }, /name must be a non-empty string/);
    await bad({ operation: 'list_code_interpreters', sort_key: 42 }, /sort_key must be a non-empty string/);
    // region: mistyped values are rejected, not silently defaulted.
    await bad({ operation: 'list_code_interpreters', region: 42 }, /region must be a non-empty string/);
    await bad({ operation: 'list_code_interpreters', region: '' }, /region must be a non-empty string/);
  });
});

test('interpreter read injects AK/SK into the child env; the request rides stdin, never argv', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const seen = [];
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
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
    // The control plane is AK/SK-signed (the list_agents posture).
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, 'AKVALUE123');
    assert.equal(childEnv.HUAWEICLOUD_SDK_SK, 'SKVALUE456');
    // The request rides STDIN: argv is the fixed snippet only.
    assert.equal(args.length, 2);
    assert.equal(args[0], '-c');
    const request = JSON.parse(stdinData);
    assert.deepEqual(request, { operation: 'list_code_interpreters', region: 'cn-southwest-2' });
    // Region is explicit, never ambient.
    assert.equal(request.region, 'cn-southwest-2');
  });
});

test('interpreter read without credentials rejects at the boundary (metadata-chain pre-gate)', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    let spawned = false;
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => {
          spawned = true;
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      },
    );
    assert.equal(spawned, false);
    assert.equal(out.ok, false);
    assert.match(out.error, /huaweicloud_auth_init/);
    assert.match(out.error, /metadata chain/);
  });
});

test('interpreter read failure envelope carries stderr and always carries an error', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: Tools API Error: Session not found',
        }),
      },
    );
    assert.equal(out.ok, false);
    assert.equal(out.failureDetected, true);
    assert.match(out.stderr, /ToolsAPIError/);
    assert.ok(out.error, 'an ok:false payload must never carry an undefined error');
  });
});

test('interpreter read detects output pollution (exit 0, unparseable stdout)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: 'not json at all', stderr: '' }),
      },
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /output pollution/);
  });
});

test('interpreter read timeout is reported as a timeout, not a failure with a mystery cause', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
      },
    );
    assert.equal(out.ok, false);
    assert.equal(out.timedOut, true);
    assert.match(out.error, /timed out/);
  });
});

test('interpreter read SDK-missing fallthrough returns the unshaped install remediation', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({
          exitCode: 3,
          stdout: '',
          stderr: 'AGENTARTS_SDK_MISSING',
        }),
      },
    );
    assert.equal(out.ok, false);
    assert.equal(out.unshaped, true);
    assert.match(out.error, /install-agentarts/);
  });
});

test('interpreter read enrichment: API_KEY-typed get result carries the console-key advisory; IAM does not', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const apiKeyTyped = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: UUID, name: 'ci-1', auth_type: 'API_KEY', access_endpoint: 'defaultgw-x.example.com' }),
          stderr: '',
        }),
      },
    );
    assert.equal(apiKeyTyped.ok, true);
    assert.match(apiKeyTyped.notes.join(' '), /HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY/);
    assert.match(apiKeyTyped.notes.join(' '), /trap 61/);
    assert.match(apiKeyTyped.notes.join(' '), /CI-side unmeasured/);

    const iamTyped = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: UUID, name: 'ci-1', auth_type: 'IAM', access_endpoint: 'defaultgw-x.example.com' }),
          stderr: '',
        }),
      },
    );
    assert.equal(iamTyped.ok, true);
    assert.equal(iamTyped.notes, undefined);
  });
});

test('interpreter read enrichment: a non-empty list teaches the trap-89 auth_type gap; an empty list stays quiet', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const nonEmpty = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            total_count: 1,
            items: [{ id: UUID, name: 'ci-1', access_endpoint: 'defaultgw-x.example.com' }],
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(nonEmpty.ok, true);
    assert.match(nonEmpty.notes.join(' '), /NO auth_type/);
    assert.match(nonEmpty.notes.join(' '), /trap 89/);

    const empty = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ total_count: 0, items: [] }), stderr: '' }),
      },
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.notes, undefined);
  });
});

test('interpreter read success carries the parsed result; the dispatch surfaces the same boundary through tools.mjs', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const out = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: UUID, name: 'ci-1', auth_type: 'IAM' }),
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.failureDetected, false);
    assert.deepEqual(out.result, { id: UUID, name: 'ci-1', auth_type: 'IAM' });

    // tools.mjs dispatch wiring: a boundary rejection proves the case
    // reaches the interpreter bridge (no spawn needed).
    const dispatched = await callTool('huaweicloud_agentarts_interpreter_read', {
      operation: 'list_code_interpreters',
      limit: 'not-a-number',
    });
    assert.equal(dispatched.ok, false);
    assert.match(dispatched.error, /limit must be an integer/);

    const unknownTool = await callAgentartsInterpreterTool('huaweicloud_agentarts_interpreter_nonexistent', {});
    assert.equal(unknownTool.ok, false);
    assert.match(unknownTool.error, /Unknown agentarts interpreter tool/);
  });
});

test('the interpreter read tool definition pins its operation enum and credential posture', async () => {
  const def = AGENTARTS_INTERPRETER_TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_agentarts_interpreter_read');
  assert.ok(def, 'missing huaweicloud_agentarts_interpreter_read definition');
  assert.deepEqual(
    [...INTERPRETER_READ_OPERATIONS].sort((a, b) => a.localeCompare(b)),
    ['get_code_interpreter', 'list_code_interpreters'],
  );
  assert.deepEqual(
    [...def.inputSchema.properties.operation.enum].sort((a, b) => a.localeCompare(b)),
    [...INTERPRETER_READ_OPERATIONS].sort((a, b) => a.localeCompare(b)),
  );
  // The credential channel is the injected AK/SK — the tool must never
  // accept a key parameter of any spelling.
  for (const banned of ['api_key', 'apiKey', 'api-key', 'key', 'sk', 'ak']) {
    assert.equal(banned in def.inputSchema.properties, false, `tool must not accept a ${banned} parameter`);
  }
  // buildChildEnv with injectCredentials keeps the interpreter ENDPOINT
  // env names OUT of the whitelist: the SDK resolves CI env > ctor param >
  // runtime env (trap 82), so an ambient endpoint env must never override
  // the bridge's constructor parameter. The API-KEY env IS whitelisted
  // (CI3, mirroring the browser key posture): the SDK reads
  // HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY on every data-plane call for
  // API_KEY-typed interpreters — riding the allowlist is harmless for
  // IAM-typed work (open_ak_sk ignores it) and the memory bridges pass
  // injectCredentials: false and never see it.
  const env = buildChildEnv({ injectCredentials: true });
  assert.equal('AGENTARTS_CODEINTERPRETER_DATA_ENDPOINT' in env, false);
  assert.equal('AGENTARTS_RUNTIME_DATA_ENDPOINT' in env, false);
  // The API-KEY passthrough rides the credential block (a child with no
  // injectable AK/SK is the /dev/null path — no data-plane key either).
  setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
  process.env.HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY = 'CI-KEY-1';
  try {
    const withKey = buildChildEnv({ injectCredentials: true });
    assert.equal(withKey.HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY, 'CI-KEY-1');
    const memoryEnv = buildChildEnv({ injectCredentials: false });
    assert.equal(memoryEnv.HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY, undefined);
  } finally {
    delete process.env.HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY;
    clearRuntimeCredentials();
  }
});

// ---------------------------------------------------------------------------
// CI2-R1 adversarial-review round: request passthrough (the silent-no-op
// class), the SystemExit contract, the truncation/timedOut envelope
// branches, redaction of every surface, -0, region steering, and the
// rejection-echo redaction.

test('interpreter read request carries every validated field; region param wins over the default', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    let request = null;
    const out = await readAgentartsInterpreter(
      {
        operation: 'list_code_interpreters',
        name: 'team-interpreter',
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
    // Full passthrough: dropping ANY of these fields is the silent-no-op
    // class (the request builder mutation M1/M2 survival class, CI2-R1).
    assert.deepEqual(request, {
      operation: 'list_code_interpreters',
      region: 'cn-north-4',
      name: 'team-interpreter',
      limit: 50,
      offset: 10,
      sort_dir: 'asc',
    });
    // sort_key omitted → the SDK default applies server-side.
    assert.equal(request.sort_key, undefined);

    let getRequest = null;
    const got = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID, region: 'cn-north-4' },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          getRequest = JSON.parse(stdinData);
          return { exitCode: 0, stdout: pyDumps({ id: UUID, name: 'ci-1' }), stderr: '' };
        },
      },
    );
    assert.equal(got.ok, true);
    assert.deepEqual(getRequest, {
      operation: 'get_code_interpreter',
      region: 'cn-north-4',
      code_interpreter_id: UUID,
    });
  });
});

test('interpreter read rejects -0 integers and non-region-shaped region strings (steering gate)', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await readAgentartsInterpreter(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'list_code_interpreters', limit: -0 }, /limit must be an integer/);
    await bad({ operation: 'list_code_interpreters', offset: -0 }, /offset must be an integer/);
    // The region interpolates into the hostname of the AK/SK-signed
    // request — host metacharacters and dotted suffixes must not ride it
    // (CI2-R1: 'attacker.invalid#' and 'cn-southwest-2.evil.example' both
    // reached the wire before this gate).
    await bad({ operation: 'list_code_interpreters', region: 'attacker.invalid#' }, /region must match/);
    await bad({ operation: 'list_code_interpreters', region: 'cn-southwest-2.evil.example' }, /region must match/);
    await bad({ operation: 'list_code_interpreters', region: 'CN SOUTH' }, /region must match/);
    // Legal region ids still pass.
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const ok = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters', region: 'cn-north-4' },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          assert.equal(JSON.parse(stdinData).region, 'cn-north-4');
          return { exitCode: 0, stdout: '{"total_count": 0}', stderr: '' };
        },
      },
    );
    assert.equal(ok.ok, true);
  });
});

test('interpreter envelope: the timedOut branch and the truncation side file both fire', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // timedOut: exit-0 stdout is IGNORED (the timeout verdict wins) and
    // the error names the timeout.
    const timedOut = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '{"id": "x"}', stderr: '', timedOut: true }),
      },
    );
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.error, /timed out after/);
    assert.equal('result' in timedOut, false, 'a timed-out call carries no result');
    // Truncation: >50KB stdout fires the side file — the payload keeps a
    // 2000-char prefix + pointer, and `result` is DROPPED (the
    // untruncated object must not sit next to a truncated stdout).
    const big = { items: [{ id: UUID, name: 'ci-1', pad: 'x'.repeat(60_000) }], total_count: 1 };
    const truncated = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: pyDumps(big), stderr: '' }),
      },
    );
    assert.equal(truncated.ok, true);
    assert.match(truncated.stdout, /truncated, full output saved to/);
    assert.equal('result' in truncated, false, 'result must be dropped when the side file fires');
  });
});

test('interpreter envelope redacts secrets on every surface (result and raw stdout)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // result surface: a secret riding the parsed JSON payload.
    const secretInResult = await readAgentartsInterpreter(
      { operation: 'get_code_interpreter', code_interpreter_id: UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ id: UUID, api_key: 'AKLTSECRETAK12345678', name: 'ci-1' }),
          stderr: '',
        }),
      },
    );
    assert.equal(secretInResult.ok, true);
    assert.doesNotMatch(JSON.stringify(secretInResult.result), /AKLTSECRETAK/);
    assert.match(JSON.stringify(secretInResult.result), /<redacted>/);
    // raw stdout surface: a secret in unparseable output.
    const secretInStdout = await readAgentartsInterpreter(
      { operation: 'list_code_interpreters' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: 'error: sk=SKLEAKEDVALUE happened',
          stderr: 'api_key: AKLTLEAKEDVALUE',
        }),
      },
    );
    assert.equal(secretInStdout.ok, false);
    assert.doesNotMatch(secretInStdout.stdout, /SKLEAKEDVALUE/);
    assert.doesNotMatch(secretInStdout.stderr, /AKLTLEAKEDVALUE/);
  });
});

test('interpreter rejection payloads redact the echoed caller-controlled strings', async () => {
  await withIsolation(async () => {
    // A secret pasted into the operation rides the reject response's
    // operation label — redacted, never verbatim (CI2-R1 echo finding;
    // the CLI wrapper's reject() redacts its args for the same reason).
    const out = await readAgentartsInterpreter({ operation: 'sk=LEAKEDSKVALUE456 xyz' });
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.operation, /LEAKEDSKVALUE/);
    assert.match(out.operation, /interpreter/);
    // Same class for an unknown-param KEY.
    const unknown = await readAgentartsInterpreter({
      operation: 'list_code_interpreters',
      'ak=AKLEAKEDKEY': 'x',
    });
    assert.equal(unknown.ok, false);
    assert.doesNotMatch(unknown.error, /AKLEAKEDKEY/);
    // And the dispatch's unknown-tool name.
    const dispatch = await callAgentartsInterpreterTool('tool sk=DISPATCHLEAK', {});
    assert.equal(dispatch.ok, false);
    assert.doesNotMatch(dispatch.error, /DISPATCHLEAK/);
  });
});

// ---------------------------------------------------------------------------
// CI3: the write bridge (resource lifecycle plan/write pair).

test('interpreter write validates the boundary before any token is minted', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = planAgentartsInterpreterWrite(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
      assert.equal(out.approvalToken, undefined, 'a rejected plan must mint no token');
    };
    await bad({ operation: 'stop_session' }, /operation must be one of/);
    await bad({ operation: 'create_code_interpreter' }, /name is required/);
    await bad({ operation: 'create_code_interpreter', name: 'Bad_Name' }, /name must match/);
    await bad({ operation: 'create_code_interpreter', name: 'x' }, /name must match/);
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', description: '' },
      /description must be a non-empty string/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', description: 42 },
      /description must be a non-empty string/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', auth_type: 'BOTH' },
      /auth_type must be "IAM" or "API_KEY"/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', auth_type: 'API_KEY' },
      /api_key_name is required when auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', api_key_name: 'k1' },
      /api_key_name only applies to auth_type=API_KEY/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', auth_type: 'API_KEY', api_key_name: 'bad key!' },
      /api_key_name must match/,
    );
    await bad({ operation: 'update_code_interpreter' }, /code_interpreter_id is required/);
    await bad({ operation: 'update_code_interpreter', code_interpreter_id: 'nope' }, /must be a valid UUID/);
    await bad({ operation: 'update_code_interpreter', code_interpreter_id: UUID }, /requires a non-empty tags array/);
    await bad({ operation: 'delete_code_interpreter' }, /code_interpreter_id is required/);
    // Unknown params + applicability (the silent-no-op class).
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', network_config: {} },
      /Unknown parameter "network_config"/,
    );
    await bad(
      { operation: 'delete_code_interpreter', code_interpreter_id: UUID, tags: [{ key: 'a', value: 'b' }] },
      /"tags" is not a parameter of delete_code_interpreter/,
    );
    // Tags shape rules (the SDK create-side rules, enforced pre-mint).
    await bad({ operation: 'create_code_interpreter', name: 'ci-1', tags: 'nope' }, /tags must be an array/);
    await bad(
      {
        operation: 'create_code_interpreter',
        name: 'ci-1',
        tags: [
          { key: 'a', value: 'b' },
          { key: 'a', value: 'c' },
        ],
      },
      /duplicates key "a"/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', tags: [{ key: 'a' }] },
      /must have exactly the keys "key" and "value"/,
    );
    await bad(
      { operation: 'create_code_interpreter', name: 'ci-1', tags: [{ key: '', value: 'b' }] },
      /\.key and \.value must be non-empty strings/,
    );
    // Region steering gate binds the write pair too.
    await bad({ operation: 'create_code_interpreter', name: 'ci-1', region: 'attacker.invalid#' }, /region must match/);
  });
});

test('interpreter write plan canonicalizes the request and mints a token', async () => {
  await withIsolation(async () => {
    const plan = planAgentartsInterpreterWrite({
      operation: 'create_code_interpreter',
      name: 'team-interpreter',
      description: 'for the spike',
      tags: [
        { key: 'zeta', value: '1' },
        { key: 'alpha', value: '2' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.ok(plan.approvalToken);
    // auth_type canonicalized to IAM (the CI1 verdict); tags SORTED by key;
    // approval note teaches the IAM posture.
    assert.deepEqual(plan.request, {
      operation: 'create_code_interpreter',
      region: 'cn-southwest-2',
      name: 'team-interpreter',
      auth_type: 'IAM',
      description: 'for the spike',
      tags: [
        { key: 'alpha', value: '2' },
        { key: 'zeta', value: '1' },
      ],
    });
    assert.match(plan.approvalNote, /auth_type defaults to IAM/);

    const apiKeyPlan = planAgentartsInterpreterWrite({
      operation: 'create_code_interpreter',
      name: 'team-interpreter',
      auth_type: 'API_KEY',
      api_key_name: 'team-key',
    });
    assert.equal(apiKeyPlan.request.auth_type, 'API_KEY');
    assert.equal(apiKeyPlan.request.api_key_name, 'team-key');
    assert.match(apiKeyPlan.approvalNote, /console api_key/);

    // update binds only id + tags; delete binds only id (with the
    // irreversible label).
    const update = planAgentartsInterpreterWrite({
      operation: 'update_code_interpreter',
      code_interpreter_id: UUID,
      tags: [{ key: 'env', value: 'prod' }],
    });
    assert.deepEqual(update.request, {
      operation: 'update_code_interpreter',
      region: 'cn-southwest-2',
      code_interpreter_id: UUID,
      tags: [{ key: 'env', value: 'prod' }],
    });
    const del = planAgentartsInterpreterWrite({ operation: 'delete_code_interpreter', code_interpreter_id: UUID });
    assert.deepEqual(del.labels, ['irreversible']);
    assert.match(del.approvalNote, /Labels: irreversible/);
    // Empty tags are dropped (unset), not [].
    const noTags = planAgentartsInterpreterWrite({ operation: 'create_code_interpreter', name: 'ci-1', tags: [] });
    assert.equal('tags' in noTags.request, false);
  });
});

test('interpreter write plan warns on credential-shaped description and tag content', async () => {
  await withIsolation(async () => {
    for (const key of ['access_key', 'admin_pass', 'authorization', 'api_key', 'token']) {
      const plan = planAgentartsInterpreterWrite({
        operation: 'create_code_interpreter',
        name: 'team-interpreter',
        tags: [{ key, value: 'x' }],
      });
      assert.ok(plan.warnings.length >= 1, `key "${key}" must fire the warning`);
    }
    for (const value of ['AKLT2e2423ab', 'ghp_1234567890abcdefghij', 'postgres://u:secretpw@host/db']) {
      const plan = planAgentartsInterpreterWrite({
        operation: 'create_code_interpreter',
        name: 'team-interpreter',
        tags: [{ key: 'note', value }],
      });
      assert.ok(plan.warnings.length >= 1, `value "${value.slice(0, 6)}…" must fire the warning`);
    }
    const desc = planAgentartsInterpreterWrite({
      operation: 'create_code_interpreter',
      name: 'team-interpreter',
      description: 'password=hunter2 for the demo',
    });
    assert.ok(desc.warnings.length >= 1, 'credential-shaped description must fire the warning');
    const clean = planAgentartsInterpreterWrite({
      operation: 'create_code_interpreter',
      name: 'team-interpreter',
      tags: [{ key: 'env', value: 'prod' }],
    });
    assert.deepEqual(clean.warnings, []);
  });
});

test('interpreter write binds the exact planned request; a mismatch rejects without consuming', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const params = { operation: 'delete_code_interpreter', code_interpreter_id: UUID };
    const plan = planAgentartsInterpreterWrite(params);
    // Changed parameters → CONFIRM_TOKEN_MISMATCH, token NOT consumed.
    const mismatch = await runAgentartsInterpreterWrite(
      {
        ...params,
        code_interpreter_id: '00000000-0000-0000-0000-000000000000',
        approvedByUser: true,
        approvalToken: plan.approvalToken,
      },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'CONFIRM_TOKEN_MISMATCH');
    const store = createApprovalTokenStore('agentarts-interpreter-sdk');
    assert.equal(store.inspect(plan.approvalToken).state, 'valid');
    // Exact parameters → executes once; the request the child received is
    // the canonical one; a replay answers already_processed.
    let seen = null;
    const out = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen = JSON.parse(stdinData);
          return { exitCode: 0, stdout: '{"deleted": true}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(seen, plan.request);
    assert.match(out.notes.join(' '), /cascades to the interpreter/);
    assert.equal(store.inspect(plan.approvalToken).state, 'already_consumed');
    const replay = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(replay.outcome, 'already_processed');
    assert.match(replay.note, /huaweicloud_agentarts_interpreter_read/);
  });
});

test('interpreter write gates: attestation, token presence, not-found wording, credential pre-consumption', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'delete_code_interpreter', code_interpreter_id: UUID };
    await assert.rejects(
      () => runAgentartsInterpreterWrite({ ...params, approvalToken: 'x' }),
      /approvedByUser must be true/,
    );
    const noToken = await runAgentartsInterpreterWrite({ ...params, approvedByUser: true });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /approvalToken is required/);
    const notFound = await runAgentartsInterpreterWrite({
      ...params,
      approvedByUser: true,
      approvalToken: 'never-issued-token',
    });
    assert.equal(notFound.code, 'CONFIRM_TOKEN_NOT_FOUND');
    assert.match(notFound.error, /verify with huaweicloud_agentarts_interpreter_read BEFORE re-planning/);
    // Missing credentials reject BEFORE consumption (token stays valid).
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    const plan = planAgentartsInterpreterWrite(params);
    clearRuntimeCredentials();
    const noCreds = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(noCreds.ok, false);
    assert.equal(noCreds.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(noCreds.error, /token was NOT consumed/);
    assert.equal(createApprovalTokenStore('agentarts-interpreter-sdk').inspect(plan.approvalToken).state, 'valid');
  });
});

test('interpreter write failure burns the token with a disclosure; SDK-missing fallthrough stays honest', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = { operation: 'delete_code_interpreter', code_interpreter_id: UUID };
    const plan = planAgentartsInterpreterWrite(params);
    const failed = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      { runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ToolsAPIError: Tools API Error: boom' }) },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /single-use token was consumed by this attempt — re-plan/);

    const plan2 = planAgentartsInterpreterWrite(params);
    const unshaped = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan2.approvalToken },
      { runCandidate: async () => ({ exitCode: 3, stdout: '', stderr: 'AGENTARTS_SDK_MISSING' }) },
    );
    assert.equal(unshaped.ok, false);
    assert.equal(unshaped.unshaped, true);
    assert.match(unshaped.error, /token was already CONSUMED by this attempt and stays burned/);
  });
});

test('interpreter write success notes teach the measured traps per operation', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const run = async (params, stdout) => {
      const plan = planAgentartsInterpreterWrite(params);
      return runAgentartsInterpreterWrite(
        { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
        { runCandidate: async () => ({ exitCode: 0, stdout, stderr: '' }) },
      );
    };
    const created = await run(
      { operation: 'create_code_interpreter', name: 'team-interpreter' },
      pyDumps({
        id: UUID,
        name: 'team-interpreter',
        auth_type: 'IAM',
        access_endpoint: 'defaultgw-x.example.com',
        status: 'RUNNING',
      }),
    );
    assert.equal(created.ok, true);
    assert.match(created.notes.join(' '), /access_endpoint/);
    assert.match(created.notes.join(' '), /trap 82/);
    assert.match(created.notes.join(' '), /trap 63 family/);

    const updated = await run(
      { operation: 'update_code_interpreter', code_interpreter_id: UUID, tags: [{ key: 'env', value: 'prod' }] },
      pyDumps({ id: UUID, tags: [{ key: 'env', value: 'prod' }] }),
    );
    assert.match(updated.notes.join(' '), /success ≠ applied/);
    assert.match(updated.notes.join(' '), /trap 45/);

    const deleted = await run({ operation: 'delete_code_interpreter', code_interpreter_id: UUID }, '{"deleted": true}');
    assert.match(deleted.notes.join(' '), /cascades to the interpreter/);
    assert.match(deleted.notes.join(' '), /2-10 seconds/);
    assert.match(deleted.notes.join(' '), /trap 89/);
  });
});

test(
  'the interpreter write snippet synthesizes a result when the SDK returns None (empty-body 200)',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async () => {
      const source = readFileSync('plugins/huaweicloud-core/src/agentarts-interpreter.mjs', 'utf8');
      const match = source.match(/const INTERPRETER_WRITE_SNIPPET = \[([\s\S]*?)\]\.join\('\\n'\);/);
      assert.ok(match, 'snippet extraction failed');
      const snippetLines = eval(`[${match[1]}]`); // repo-owned source, test-only eval
      const snippet = snippetLines.join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'interpreter-snippet-'));
      const snippetPath = join(dir, 'snippet.py');
      writeFileSync(snippetPath, snippet);
      const driver = join(dir, 'driver.py');
      writeFileSync(
        driver,
        [
          'import sys, types',
          "fake = types.ModuleType('agentarts')",
          "sdk = types.ModuleType('agentarts.sdk')",
          'class CodeInterpreter:',
          '    def __init__(self, region=None, data_endpoint=None, auth_type="API_KEY", verify_ssl=True):',
          '        pass',
          '    def update_code_interpreter(self, code_interpreter_id, observability=None, tags=None):',
          '        return None  # empty-body 200 transport shape',
          '    def delete_code_interpreter(self, code_interpreter_id):',
          '        return None',
          'sdk.CodeInterpreter = CodeInterpreter',
          'fake.sdk = sdk',
          "sys.modules['agentarts'] = fake",
          "sys.modules['agentarts.sdk'] = sdk",
          "exec(compile(open(sys.argv[1]).read(), 'snippet', 'exec'))",
          '',
        ].join('\n'),
      );
      const request = pyDumps({
        operation: 'update_code_interpreter',
        region: 'cn-southwest-2',
        code_interpreter_id: UUID,
        tags: [{ key: 'env', value: 'prod' }],
      });
      const out = spawnSync('python3', [driver, snippetPath], { input: request, encoding: 'utf8', timeout: 15_000 });
      assert.equal(out.status, 0, `snippet must exit 0 (stderr: ${out.stderr})`);
      const parsed = JSON.parse(out.stdout);
      assert.deepEqual(parsed, { updated: true, code_interpreter_id: UUID });
      rmSync(dir, { recursive: true, force: true });
    });
  },
);

test(
  'the interpreter approval store fails CLOSED when the tombstone cannot persist',
  { skip: process.platform === 'win32' },
  async () => {
    await withIsolation(async (home) => {
      const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
      const storeDir = join(home, '.config', 'huaweicloud');
      mkdirSync(storeDir, { recursive: true });
      const store = createApprovalTokenStore('agentarts-interpreter-sdk');
      const token = store.create(['["x"]']);
      const storePath = join(storeDir, 'approvals.json');
      assert.ok(existsSync(storePath), 'create must persist');
      chmodSync(storeDir, 0o555);
      try {
        assert.throws(() => store.consume(token), /ENOENT|EACCES|EPERM/);
      } finally {
        chmodSync(storeDir, 0o755);
      }
      assert.equal(store.inspect(token).state, 'valid');
      assert.ok(store.consume(token));
      assert.equal(store.inspect(token).state, 'already_consumed');

      // End-to-end: the unwritable store surfaces as
      // TOKEN_STORE_UNWRITABLE with the not-consumed disclosure, and the
      // SAME token still executes once writable again.
      setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
      const params = { operation: 'delete_code_interpreter', code_interpreter_id: UUID };
      const plan = planAgentartsInterpreterWrite(params);
      chmodSync(storeDir, 0o555);
      let blocked;
      try {
        blocked = await runAgentartsInterpreterWrite(
          { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
          { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
        );
      } finally {
        chmodSync(storeDir, 0o755);
      }
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'TOKEN_STORE_UNWRITABLE');
      assert.match(blocked.error, /NOT consumed and the write did NOT execute/);
      const retry = await runAgentartsInterpreterWrite(
        { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
        { runCandidate: async () => ({ exitCode: 0, stdout: '{"deleted": true}', stderr: '' }) },
      );
      assert.equal(retry.ok, true);
    });
  },
);

test('interpreter write tags bind order-insensitively; plan and write dispatch through tools.mjs', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The write may receive the tags in ANY order — the binding sorts.
    const params = {
      operation: 'update_code_interpreter',
      code_interpreter_id: UUID,
      tags: [
        { key: 'z', value: '1' },
        { key: 'a', value: '2' },
      ],
    };
    const plan = planAgentartsInterpreterWrite(params);
    const out = await runAgentartsInterpreterWrite(
      {
        ...params,
        tags: [
          { key: 'a', value: '2' },
          { key: 'z', value: '1' },
        ],
        approvedByUser: true,
        approvalToken: plan.approvalToken,
      },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{"updated": true}', stderr: '' }) },
    );
    assert.equal(out.ok, true);

    // tools.mjs dispatch wiring for the write pair.
    const planDispatched = await callTool('huaweicloud_agentarts_interpreter_plan', {
      operation: 'create_code_interpreter',
    });
    assert.equal(planDispatched.ok, false);
    assert.match(planDispatched.error, /name is required/);
    const writeDispatched = await callTool('huaweicloud_agentarts_interpreter_write', {
      operation: 'delete_code_interpreter',
      code_interpreter_id: UUID,
      approvedByUser: true,
      approvalToken: 'never-issued',
    });
    assert.equal(writeDispatched.ok, false);
    assert.equal(writeDispatched.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// CI4: session lifecycle (start_session write extension + the free
// session tool).

const SESSION_UUID = 'd103eff1-5b12-4601-8528-398b5cb303d6';

function writeSessionFile(home, state) {
  mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
  const path = join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${state.session_id}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { path };
}

function fullSessionState(overrides = {}) {
  return {
    code_interpreter_id: UUID,
    code_interpreter_name: 'team-interpreter',
    auth_type: 'IAM',
    region: 'cn-southwest-2',
    data_endpoint: 'defaultgw-x.example.com',
    session_id: SESSION_UUID,
    session_name: 'work',
    session_timeout: 900,
    started_at: Date.now() - 1000,
    lease_expires_at: Date.now() + 899_000,
    ...overrides,
  };
}

test('start_session validates the boundary: names, timeout range, applicability', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = planAgentartsInterpreterWrite({ operation: 'start_session', ...params });
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
      assert.equal(out.approvalToken, undefined, 'a rejected plan must mint no token');
    };
    await bad({}, /code_interpreter_name is required/);
    await bad({ code_interpreter_name: 'Bad_Name', session_name: 's1' }, /code_interpreter_name must match/);
    await bad({ code_interpreter_name: 'ci-1' }, /session_name is required/);
    await bad({ code_interpreter_name: 'ci-1', session_name: 'has space!' }, /session_name must match/);
    await bad(
      { code_interpreter_name: 'ci-1', session_name: 's1', session_timeout: 59 },
      /session_timeout must be 60-86400/,
    );
    await bad(
      { code_interpreter_name: 'ci-1', session_name: 's1', session_timeout: 86401 },
      /session_timeout must be 60-86400/,
    );
    await bad(
      { code_interpreter_name: 'ci-1', session_name: 's1', session_timeout: true },
      /session_timeout must be an integer/,
    );
    await bad(
      { code_interpreter_name: 'ci-1', session_name: 's1', session_timeout: 900.5 },
      /session_timeout must be an integer/,
    );
    // Applicability: create-only fields are silent no-ops on start.
    await bad(
      { code_interpreter_name: 'ci-1', session_name: 's1', tags: [{ key: 'a', value: 'b' }] },
      /"tags" is not a parameter of start_session/,
    );
    await bad({ code_interpreter_name: 'ci-1', session_name: 's1', region: 'bad region' }, /region must match/);
  });
});

test('start_session plan: orphan guard rejects a live lease and sweeps stale/malformed records', async () => {
  await withIsolation(async (home) => {
    // Live lease → rejected at plan time, no token minted.
    writeSessionFile(home, fullSessionState());
    const blocked = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'second',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /unexpired session lease already exists/);
    assert.match(blocked.error, /stop_session/);
    assert.equal(blocked.approvalToken, undefined);

    // Different interpreter name → no conflict.
    const other = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'other-interpreter',
      session_name: 's1',
    });
    assert.equal(other.ok, true);
    assert.ok(other.approvalToken);

    // Expired lease → swept (the stale record is unlinked).
    writeSessionFile(home, fullSessionState({ lease_expires_at: Date.now() - 1000 }));
    const sweep = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'second',
    });
    assert.equal(sweep.ok, true, 'an expired lease must be swept, not a conflict');
    const stalePath = join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`);
    assert.equal(existsSync(stalePath), false, 'the stale lease record must be swept');
  });
});

test('start_session plan canonical request binds the lease scope; timeout only when set', async () => {
  await withIsolation(async () => {
    const plan = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
    });
    assert.deepEqual(plan.request, {
      operation: 'start_session',
      region: 'cn-southwest-2',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
    });
    assert.match(plan.approvalNote, /starts the session AND its lease/);
    assert.match(plan.approvalNote, /trap 85/);
    const withTimeout = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
      session_timeout: 3600,
    });
    assert.equal(withTimeout.request.session_timeout, 3600);
  });
});

test('start_session write: pre-consume guard recheck, session snippet routing, lease capture + notes', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
    };
    const plan = planAgentartsInterpreterWrite(params);
    // Pre-consume recheck: a live lease appeared between plan and write —
    // rejected with the token NOT consumed.
    writeSessionFile(home, fullSessionState());
    const conflict = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'SESSION_LEASE_CONFLICT');
    assert.match(conflict.error, /token was NOT consumed/);
    const { createApprovalTokenStore } = await import('../plugins/huaweicloud-core/src/approval-tokens.mjs');
    assert.equal(createApprovalTokenStore('agentarts-interpreter-sdk').inspect(plan.approvalToken).state, 'valid');

    // Clear the lease and run the real write: the session snippet (NOT the
    // resource snippet) executes, the lease file is captured from the raw
    // stdout, and the notes carry the trap-85 teaching.
    const leasePath = join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`);
    unlinkSync(leasePath);
    let snippetSeen = null;
    let requestSeen = null;
    const out = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          snippetSeen = args[1];
          requestSeen = JSON.parse(stdinData);
          return {
            exitCode: 0,
            stdout: pyDumps({
              interpreter: {
                id: UUID,
                name: 'team-interpreter',
                auth_type: 'IAM',
                access_endpoint: 'defaultgw-x.example.com',
              },
              session_id: SESSION_UUID,
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.match(snippetSeen, /"start_session"/);
    assert.doesNotMatch(snippetSeen, /create_code_interpreter/);
    assert.deepEqual(requestSeen, plan.request);
    // The lease file exists, 0600, with the full addressing pair.
    assert.ok(existsSync(leasePath), 'the lease record must be written');
    assert.equal(statSync(leasePath).mode & 0o777, 0o600);
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    assert.equal(lease.code_interpreter_name, 'team-interpreter');
    assert.equal(lease.session_id, SESSION_UUID);
    assert.equal(lease.data_endpoint, 'defaultgw-x.example.com');
    assert.equal(lease.auth_type, 'IAM');
    assert.equal(lease.session_timeout, 900);
    assert.ok(typeof lease.lease_expires_at === 'number');
    assert.match(out.notes.join(' '), /Session lease recorded/);
    assert.match(out.notes.join(' '), /trap 85/);
    assert.match(out.notes.join(' '), /0600/);
  });
});

test('start_session write: API_KEY-missing error mapping and unshapable-capture WARNING branch', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
    };
    // Failure with the API_KEY shape carries the console-key guidance.
    const plan = planAgentartsInterpreterWrite(params);
    const apiKeyMissing = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ValueError: API Key is not provided and not found in environment variable.',
        }),
      },
    );
    assert.equal(apiKeyMissing.ok, false);
    assert.match(apiKeyMissing.error, /HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY/);
    assert.match(apiKeyMissing.error, /token was consumed/);

    // A success whose stdout shape is not the capture shape: the lease
    // record cannot be written — the WARNING branch discloses the live
    // session id.
    const plan2 = planAgentartsInterpreterWrite(params);
    const unshapable = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan2.approvalToken },
      { runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ odd: 'shape' }), stderr: '' }) },
    );
    assert.equal(unshapable.ok, true);
    assert.match(unshapable.notes.join(' '), /WARNING: the session state file could NOT be captured/);
    assert.match(unshapable.notes.join(' '), /\(unreadable\)/);
  });
});

test('the interpreter session tool: free ops, file addressing, expiry-reachable stop, mappings', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Boundary: op enum, unknown params, session_id shape.
    assert.equal(
      (await runAgentartsInterpreterSession({ operation: 'execute_code', session_id: SESSION_UUID })).ok,
      false,
    );
    assert.match((await runAgentartsInterpreterSession({ operation: 'get_session' })).error, /session_id is required/);
    assert.match(
      (await runAgentartsInterpreterSession({ operation: 'get_session', session_id: 'nope' })).error,
      /must be a valid UUID/,
    );
    assert.match(
      (
        await runAgentartsInterpreterSession({
          operation: 'stop_session',
          session_id: SESSION_UUID,
          region: 'cn-southwest-2',
        })
      ).error,
      /Unknown parameter "region"/,
    );
    // No file → start guidance.
    const noFile = await runAgentartsInterpreterSession({ operation: 'get_session', session_id: SESSION_UUID });
    assert.equal(noFile.ok, false);
    assert.match(noFile.error, /No session state file/);
    // Malformed file (missing lease) → rejected as malformed.
    writeSessionFile(home, { session_id: SESSION_UUID, code_interpreter_name: 'ci-1' });
    assert.match(
      (await runAgentartsInterpreterSession({ operation: 'get_session', session_id: SESSION_UUID })).error,
      /malformed/,
    );
    unlinkSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`));

    // get_session: the request carries the full addressing pair from the
    // file, and both name + session_id reach the wire.
    writeSessionFile(home, fullSessionState());
    let request = null;
    const got = await runAgentartsInterpreterSession(
      { operation: 'get_session', session_id: SESSION_UUID },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          request = JSON.parse(stdinData);
          return {
            exitCode: 0,
            stdout: pyDumps({
              code_interpreter_name: 'team-interpreter',
              session_id: SESSION_UUID,
              name: 'work',
              created_at: 't',
              session_timeout: 900,
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(got.ok, true);
    assert.deepEqual(request, {
      operation: 'get_session',
      region: 'cn-southwest-2',
      data_endpoint: 'defaultgw-x.example.com',
      auth_type: 'IAM',
      code_interpreter_name: 'team-interpreter',
      session_id: SESSION_UUID,
    });

    // stop_session: deletes the lease file, teaches the trap-87 no-op.
    const stopped = await runAgentartsInterpreterSession(
      { operation: 'stop_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ stopped: true, session_id: SESSION_UUID }),
          stderr: '',
        }),
      },
    );
    assert.equal(stopped.ok, true);
    assert.match(stopped.notes.join(' '), /lease record was removed/);
    assert.match(stopped.notes.join(' '), /trap 87/i);
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`)),
      false,
    );

    // EXPIRED lease: stop stays reachable (trap 85 — the only
    // deterministic cleanup) and the staleness is disclosed.
    writeSessionFile(home, fullSessionState({ lease_expires_at: Date.now() - 60_000 }));
    const expiredStop = await runAgentartsInterpreterSession(
      { operation: 'stop_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ stopped: true, session_id: SESSION_UUID }),
          stderr: '',
        }),
      },
    );
    assert.equal(expiredStop.ok, true, 'stop must not hard-gate on the local lease clock');
    assert.match(expiredStop.notes.join(' '), /local lease expired/);
    assert.match(expiredStop.notes.join(' '), /trap 85/);

    // Error mappings: session death vs interpreter deletion vs API key.
    // A CONFIRMED death signature clears the lease record (the D2
    // lockout fix — a dead session's record must not guard-block the
    // re-start), so each case re-writes its own record first.
    const leasePath = () => join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`);
    writeSessionFile(home, fullSessionState());
    const sessionDead = await runAgentartsInterpreterSession(
      { operation: 'get_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: Tools API Error: Session not found',
        }),
      },
    );
    assert.match(sessionDead.error, /cloud session is gone/);
    assert.match(sessionDead.error, /lease record was removed/);
    assert.match(sessionDead.error, /no longer guard-blocked/);
    assert.equal(existsSync(leasePath()), false, 'a confirmed death signature must clear the record');

    writeSessionFile(home, fullSessionState());
    const interpreterDead = await runAgentartsInterpreterSession(
      { operation: 'stop_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: Tools API Error: No matching policy found',
        }),
      },
    );
    assert.match(interpreterDead.error, /INTERPRETER itself is gone/);
    assert.match(interpreterDead.error, /trap 86/);
    assert.equal(existsSync(leasePath()), false, 'the interpreter-deleted signature must clear the record too');

    // The lockout is gone: with the record cleared by the death
    // signature, a re-start plan is no longer guard-blocked.
    const restart = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'retry',
    });
    assert.equal(restart.ok, true, 'a cleared record must unblock the re-start plan');

    // A NON-death failure (API key missing) keeps the record — the
    // session may still be live.
    writeSessionFile(home, fullSessionState());
    const apiKey = await runAgentartsInterpreterSession(
      { operation: 'get_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ValueError: API Key is not provided and not found in environment variable.',
        }),
      },
    );
    assert.match(apiKey.error, /HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY/);
    assert.equal(existsSync(leasePath()), true, 'a non-death failure must keep the record');

    // D1: the expired-lease note is operation-specific — get never
    // claims a stop ran.
    writeSessionFile(home, fullSessionState({ lease_expires_at: Date.now() - 60_000 }));
    const expiredGet = await runAgentartsInterpreterSession(
      { operation: 'get_session', session_id: SESSION_UUID },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            code_interpreter_name: 'team-interpreter',
            session_id: SESSION_UUID,
            name: 'work',
            created_at: 't',
            session_timeout: 900,
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(expiredGet.ok, true);
    assert.match(expiredGet.notes.join(' '), /local lease expired/);
    assert.doesNotMatch(expiredGet.notes.join(' '), /this stop was the deterministic cleanup/);
    assert.match(expiredGet.notes.join(' '), /new approved start_session/);

    // D4: a credential-shaped operation rides the reject echo redacted.
    const echoed = await runAgentartsInterpreterSession({ operation: 'sk=LEAKEDSKVALUE456' });
    assert.equal(echoed.ok, false);
    assert.doesNotMatch(echoed.operation, /LEAKEDSKVALUE/);
  });
});

test('start_session discloses a post-mint concurrent lease (the check-then-act window)', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const params = {
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'work',
    };
    const plan = planAgentartsInterpreterWrite(params);
    // A FOREIGN live lease appears DURING the spawn (the write-time guard
    // ran clean before consume; anything minted after that is the
    // check-then-act window — disclosed in notes, not rejected).
    const foreignId = '1b85a120-b34c-4eb0-8b82-5c50470d4618';
    const out = await runAgentartsInterpreterWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => {
          writeSessionFile(home, fullSessionState({ session_id: foreignId }));
          return {
            exitCode: 0,
            stdout: pyDumps({
              interpreter: {
                id: UUID,
                name: 'team-interpreter',
                auth_type: 'IAM',
                access_endpoint: 'defaultgw-x.example.com',
              },
              session_id: SESSION_UUID,
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.match(out.notes.join(' '), /CONCURRENT-START WARNING/);
    assert.match(out.notes.join(' '), /1 other live lease/);
    assert.match(out.notes.join(' '), new RegExp(foreignId));
    // Both records exist now (the foreign one and our own) — the
    // disclosure names the orphan risk.
    assert.ok(existsSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`)));
    assert.ok(existsSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${foreignId}.json`)));
  });
});

test('the interpreter session tool dispatches through tools.mjs', async () => {
  await withIsolation(async () => {
    const out = await callTool('huaweicloud_agentarts_interpreter_session', {
      operation: 'get_session',
      session_id: 'not-a-uuid',
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /must be a valid UUID/);
  });
});

// ---------------------------------------------------------------------------
// CI5: the lease-gated action tool (minimal action surface).

test('interpreter invoke validates the boundary: the injection vector is closed', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await runAgentartsInterpreterInvoke(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ action: 'execute_command' }, /action must be one of/);
    await bad({ action: 'execute_code' }, /session_id is required/);
    await bad({ action: 'execute_code', session_id: 'nope' }, /must be a valid UUID/);
    // The trap-84 injection vector: whitespace (newline) and shell
    // metacharacters in package names are rejected BEFORE any spawn.
    await bad(
      { action: 'install_packages', session_id: SESSION_UUID, packages: ['definitely-not-a-real-pkg-xyz\ntrue'] },
      /must match name or name==version/,
    );
    await bad({ action: 'install_packages', session_id: SESSION_UUID, packages: ['six>=1.0'] }, /trap 84/);
    await bad(
      { action: 'install_packages', session_id: SESSION_UUID, packages: ['six; rm -rf /'] },
      /must match name or name==version/,
    );
    await bad(
      { action: 'install_packages', session_id: SESSION_UUID, packages: ['$(whoami)'] },
      /must match name or name==version/,
    );
    await bad({ action: 'install_packages', session_id: SESSION_UUID, packages: [] }, /non-empty array/);
    await bad({ action: 'install_packages', session_id: SESSION_UUID, packages: 'six' }, /non-empty array/);
    await bad(
      { action: 'install_packages', session_id: SESSION_UUID, packages: Array(21).fill('six') },
      /at most 20 items/,
    );
    await bad(
      { action: 'install_packages', session_id: SESSION_UUID, packages: ['six'], upgrade: 'yes' },
      /upgrade must be a boolean/,
    );
    // execute_code: code required, clear_context boolean.
    await bad({ action: 'execute_code', session_id: SESSION_UUID }, /code is required/);
    await bad({ action: 'execute_code', session_id: SESSION_UUID, code: '' }, /code is required/);
    await bad(
      { action: 'execute_code', session_id: SESSION_UUID, code: 'print(1)', clear_context: 'yes' },
      /clear_context must be a boolean/,
    );
    // Applicability: a legal key in the wrong action is a silent no-op.
    await bad(
      { action: 'clear_context', session_id: SESSION_UUID, code: 'print(1)' },
      /"code" is not a parameter of clear_context/,
    );
    await bad(
      { action: 'download_file', session_id: SESSION_UUID, packages: ['six'] },
      /"packages" is not a parameter of download_file/,
    );
    // upload_files: the shape rules.
    await bad({ action: 'upload_files', session_id: SESSION_UUID, files: [] }, /non-empty array/);
    await bad({ action: 'upload_files', session_id: SESSION_UUID, files: 'x' }, /non-empty array/);
    await bad(
      { action: 'upload_files', session_id: SESSION_UUID, files: [{ path: '/home/user/a', content: 'x', extra: 1 }] },
      /unknown key "extra"/,
    );
    await bad(
      { action: 'upload_files', session_id: SESSION_UUID, files: [{ path: '/tmp/a', content: 'x' }] },
      /absolute path under \/home\/user/,
    );
    await bad(
      { action: 'upload_files', session_id: SESSION_UUID, files: [{ path: '/home/user/a', content: 42 }] },
      /content must be a string \(text\) or \{base64: string\}/,
    );
    await bad(
      { action: 'upload_files', session_id: SESSION_UUID, files: [{ path: '/home/user/a', content: '' }] },
      /content must be non-empty/,
    );
    await bad(
      { action: 'upload_files', session_id: SESSION_UUID, files: [{ path: '/home/user/a', content: { base64: '' } }] },
      /content must be a string \(text\) or/,
    );
    await bad(
      {
        action: 'upload_files',
        session_id: SESSION_UUID,
        files: [{ path: '/home/user/a', content: 'x', description: 7 }],
      },
      /description must be a string/,
    );
    // download_file: the path rules.
    await bad({ action: 'download_file', session_id: SESSION_UUID }, /path is required/);
    await bad(
      { action: 'download_file', session_id: SESSION_UUID, path: '/etc/passwd' },
      /absolute path under \/home\/user/,
    );
    // Unknown top-level keys.
    await bad(
      { action: 'execute_code', session_id: SESSION_UUID, code: 'print(1)', region: 'cn-southwest-2' },
      /Unknown parameter "region"/,
    );
  });
});

test('interpreter invoke gates on the lease: no record, expired lease, live lease', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // No record → start guidance.
    const noRecord = await runAgentartsInterpreterInvoke({
      action: 'execute_code',
      session_id: SESSION_UUID,
      code: 'print(1)',
    });
    assert.equal(noRecord.ok, false);
    assert.match(noRecord.error, /No session state file/);
    // Expired lease → SESSION_LEASE_EXPIRED with the trap-85 teaching
    // (stop stays reachable; a new start needs new approval).
    writeSessionFile(home, fullSessionState({ lease_expires_at: Date.now() - 1000 }));
    const expired = await runAgentartsInterpreterInvoke({
      action: 'execute_code',
      session_id: SESSION_UUID,
      code: 'print(1)',
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'SESSION_LEASE_EXPIRED');
    assert.match(expired.error, /consent boundary/);
    assert.match(expired.error, /trap 85/);
    assert.match(expired.error, /stop stays reachable/);
    // Live lease → executes; the request carries the addressing pair from
    // the lease record plus the action payload.
    writeSessionFile(home, fullSessionState());
    let request = null;
    const out = await runAgentartsInterpreterInvoke(
      { action: 'execute_code', session_id: SESSION_UUID, code: 'print("x")', clear_context: false },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          request = JSON.parse(stdinData);
          return {
            exitCode: 0,
            stdout: pyDumps({ result: { content: [{ type: 'text', text: 'x\n' }] } }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.deepEqual(request, {
      action: 'execute_code',
      region: 'cn-southwest-2',
      data_endpoint: 'defaultgw-x.example.com',
      auth_type: 'IAM',
      code_interpreter_name: 'team-interpreter',
      session_id: SESSION_UUID,
      download_dir: '/tmp/huaweicloud-devkit',
      code: 'print("x")',
      clear_context: false,
    });
    // upload_files carries the text and blob shapes verbatim.
    const upload = await runAgentartsInterpreterInvoke(
      {
        action: 'upload_files',
        session_id: SESSION_UUID,
        files: [
          { path: '/home/user/a.csv', content: 'a,b\n1,2\n', description: 'csv' },
          { path: '/home/user/b.bin', content: { base64: 'AAEC' } },
        ],
      },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          request = JSON.parse(stdinData);
          return {
            exitCode: 0,
            stdout: pyDumps({
              result: {
                content: [
                  { type: 'resource_link', mime_type: 'text/csv', name: 'a.csv', uri: 'file:///home/user/a.csv' },
                ],
              },
            }),
            stderr: '',
          };
        },
      },
    );
    assert.equal(upload.ok, true);
    assert.deepEqual(request.files, [
      { path: '/home/user/a.csv', content: 'a,b\n1,2\n', description: 'csv' },
      { path: '/home/user/b.bin', content: { base64: 'AAEC' } },
    ]);
  });
});

test('interpreter invoke enrichment: remote exception, install teaching, lease warning, death mappings', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, fullSessionState());
    // execute_code with is_error → the remote-exception teaching.
    const raised = await runAgentartsInterpreterInvoke(
      { action: 'execute_code', session_id: SESSION_UUID, code: '1/0' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ result: { content: [{ type: 'text', text: 'ZeroDivisionError: ...' }], is_error: true } }),
          stderr: '',
        }),
      },
    );
    assert.equal(raised.ok, true);
    assert.match(raised.notes.join(' '), /REMOTE python raised/);
    assert.match(raised.notes.join(' '), /trap 83/);
    // install_packages → the `==` teaching.
    const install = await runAgentartsInterpreterInvoke(
      { action: 'install_packages', session_id: SESSION_UUID, packages: ['six'] },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            result: {
              content: [{ type: 'text', text: 'Requirement already satisfied: six\n' }],
              structured_content: { exit_code: 0, stdout: 'Requirement already satisfied: six\n', stderr: '' },
            },
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(install.ok, true);
    assert.match(install.notes.join(' '), /`==` only/);
    assert.match(install.notes.join(' '), /trap 84/);
    // Lease warning window (<30s remaining).
    writeSessionFile(home, fullSessionState({ lease_expires_at: Date.now() + 10_000 }));
    const warning = await runAgentartsInterpreterInvoke(
      { action: 'clear_context', session_id: SESSION_UUID },
      { runCandidate: async () => ({ exitCode: 0, stdout: pyDumps({ result: { content: [] } }), stderr: '' }) },
    );
    assert.equal(warning.ok, true);
    assert.match(warning.notes.join(' '), /lease expires in/);
    // Death signatures clear the record (the D2 lockout fix applies to
    // invoke too) and unblock the re-start.
    writeSessionFile(home, fullSessionState());
    const dead = await runAgentartsInterpreterInvoke(
      { action: 'execute_code', session_id: SESSION_UUID, code: 'print(1)' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ToolsAPIError: Tools API Error: Session not found',
        }),
      },
    );
    assert.match(dead.error, /cloud session is gone/);
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`)),
      false,
    );
    const restart = planAgentartsInterpreterWrite({
      operation: 'start_session',
      code_interpreter_name: 'team-interpreter',
      session_name: 'retry',
    });
    assert.equal(restart.ok, true);
    // API key missing keeps the record (non-death failure).
    writeSessionFile(home, fullSessionState());
    const apiKey = await runAgentartsInterpreterInvoke(
      { action: 'execute_code', session_id: SESSION_UUID, code: 'print(1)' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'ValueError: API Key is not provided and not found in environment variable.',
        }),
      },
    );
    assert.match(apiKey.error, /HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY/);
    assert.equal(
      existsSync(join(home, '.config', 'huaweicloud', `agentarts-interpreter-session-${SESSION_UUID}.json`)),
      true,
    );
  });
});

test('interpreter invoke dispatches through tools.mjs; download binary rides a 0600 file, never base64', async () => {
  await withIsolation(async (home) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    writeSessionFile(home, fullSessionState());
    const dispatched = await callTool('huaweicloud_agentarts_interpreter_invoke', {
      action: 'install_packages',
      session_id: SESSION_UUID,
      packages: ['evil\ntrue'],
    });
    assert.equal(dispatched.ok, false);
    assert.match(dispatched.error, /must match name or name==version/);

    // Binary download: the snippet synthesizes the saved_to envelope —
    // assert the passthrough (the file write itself is snippet-side).
    const download = await runAgentartsInterpreterInvoke(
      { action: 'download_file', session_id: SESSION_UUID, path: '/home/user/out.bin' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({
            action: 'download_file',
            path: '/home/user/out.bin',
            saved_to: '/tmp/huaweicloud-devkit/agentarts-interpreter-download-x.bin',
            bytes: 4,
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(download.ok, true);
    assert.equal(download.result.saved_to, '/tmp/huaweicloud-devkit/agentarts-interpreter-download-x.bin');
    assert.equal(download.result.bytes, 4);
    // Text download rides the payload as text.
    const text = await runAgentartsInterpreterInvoke(
      { action: 'download_file', session_id: SESSION_UUID, path: '/home/user/data.csv' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: pyDumps({ action: 'download_file', path: '/home/user/data.csv', text: 'a,b\n1,2\n' }),
          stderr: '',
        }),
      },
    );
    assert.equal(text.ok, true);
    assert.equal(text.result.text, 'a,b\n1,2\n');
  });
});

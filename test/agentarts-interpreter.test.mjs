import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readAgentartsInterpreter,
  callAgentartsInterpreterTool,
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
    await bad({ operation: 'start_session' }, /operation must be one of/);
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

    const unknownTool = await callAgentartsInterpreterTool('huaweicloud_agentarts_interpreter_write', {});
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
  // buildChildEnv with injectCredentials keeps the interpreter data-plane
  // env names OUT of the whitelist: the SDK resolves CI env > ctor param >
  // runtime env (trap 82), so an ambient env must never override the
  // bridge's constructor parameter.
  const env = buildChildEnv({ injectCredentials: true });
  assert.equal('AGENTARTS_CODEINTERPRETER_DATA_ENDPOINT' in env, false);
  assert.equal('AGENTARTS_RUNTIME_DATA_ENDPOINT' in env, false);
  assert.equal('HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY' in env, false);
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

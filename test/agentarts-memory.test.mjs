import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readAgentartsMemory,
  callAgentartsMemoryTool,
  AGENTARTS_MEMORY_TOOL_DEFINITIONS,
  MEMORY_READ_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-memory.mjs';

// Isolation: HUAWEICLOUD_HOME pointed at a scratch dir so the 0600 key-file
// resolution never touches the real home (the agentarts-cli test pattern).
// EXECUTOR pattern (not a factory): the helper must await fn() inline — a
// returned-uncalled async arrow makes every test vacuously green (adversarial
// round-2 finding 1).
async function withIsolation(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agentarts-memory-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  const previousBin = process.env.AGENTARTS_BIN;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.HUAWEICLOUD_HOME = previousHome;
    process.env.AGENTARTS_BIN = previousBin;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeKeyFile(home, spaceId, key) {
  const dir = join(home, '.config', 'huaweicloud');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agentarts-memory-api-key-${spaceId}.txt`);
  writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

const KEY = 'KEY_ONETIME_mem42';

test('memory read validates the boundary before any spawn', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await readAgentartsMemory(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad({ operation: 'add_messages', space_id: 'sp1' }, /operation must be one of/);
    // Path traversal in space_id must never reach path construction.
    await bad({ operation: 'list_sessions', space_id: 'x/../../../.ssh/evil' }, /space_id must match/);
    await bad({ operation: 'get_session', space_id: 'sp1' }, /session_id is required/);
    await bad({ operation: 'get_message', space_id: 'sp1', session_id: 's1' }, /message_id is required/);
    await bad({ operation: 'get_memory', space_id: 'sp1' }, /memory_id is required/);
    // actor_id is a hard requirement for search (actor-level isolation).
    await bad(
      { operation: 'search_memories', space_id: 'sp1', filters: { query: 'deploy steps' } },
      /actor_id is REQUIRED for search_memories/,
    );
    await bad(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { top_k: 5 } },
      /filters\.query/,
    );
    // SDK limit ranges are enforced at the boundary.
    await bad({ operation: 'list_sessions', space_id: 'sp1', limit: 25 }, /limit must be 1-20/);
    await bad({ operation: 'list_messages', space_id: 'sp1', session_id: 's1', limit: 0 }, /limit must be 1-100/);
    await bad({ operation: 'list_memories', space_id: 'sp1', offset: -1 }, /offset must be >= 0/);
    await bad(
      { operation: 'get_last_k_messages', space_id: 'sp1', session_id: 's1', k: 0 },
      /k must be a positive integer/,
    );
    await bad({ operation: 'list_memories', space_id: 'sp1', filters: ['nope'] }, /filters must be an object/);
    // list_messages requires session_id: the SDK's space-wide form builds a
    // broken /sessions/None path in 0.1.7 (memory_service.py).
    await bad({ operation: 'list_messages', space_id: 'sp1' }, /session_id is required/);
    // Filter keys are allowlisted: a credential-shaped key in filters would
    // ride the argv JSON onto the process list.
    await bad(
      {
        operation: 'search_memories',
        space_id: 'sp1',
        actor_id: 'u1',
        filters: { query: 'q', api_key: 'SUPERSECRET' },
      },
      /Unknown filters key "api_key"/,
    );
    // actor_id has exactly one source (the top-level param).
    await bad(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { query: 'q', actor_id: 'u2' } },
      /filters\.actor_id is managed by the required top-level actor_id parameter/,
    );
    // sort_by/sort_order: the dataclass accepts them, the 0.1.7 HTTP layer
    // never sends them — the silent-no-op class, rejected at the boundary.
    await bad(
      { operation: 'list_memories', space_id: 'sp1', filters: { sort_by: 'updated_at' } },
      /never sends it \(memory_service\.py filter_mappings\)/,
    );
    // filters on the six non-filter operations: rejected, not silently
    // ignored (the same silent-no-op class).
    await bad(
      { operation: 'get_memory', space_id: 'sp1', memory_id: 'm1', filters: { strategy_type: 'semantic' } },
      /get_memory takes no filters/,
    );
  });
});

test('memory read fails with the bootstrap remediation when no key file exists', async () => {
  await withIsolation(async () => {
    const out = await readAgentartsMemory({ operation: 'list_sessions', space_id: 'never-created' });
    assert.equal(out.ok, false);
    assert.match(out.error, /No data-plane api_key file for space never-created/);
    assert.match(out.error, /spaces created through huaweicloud_agentarts_run_approved_command/);
    assert.match(out.error, /no re-issue command/);
  });
});

test('memory read carries the key env-only and never in argv', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const seen = [];
    const out = await readAgentartsMemory(
      { operation: 'list_sessions', space_id: 'sp1' },
      {
        runCandidate: async (candidate, args, childEnv) => {
          seen.push({ candidate, args, childEnv });
          return { exitCode: 0, stdout: '{"items": [], "total": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    const { args, childEnv } = seen[0];
    // Env-only transport: the key rides the allowlist child env…
    assert.equal(childEnv.HUAWEICLOUD_SDK_MEMORY_API_KEY, KEY);
    // …never argv (process-list visible)…
    assert.ok(!args.some((a) => String(a).includes(KEY)));
    // …and no AK/SK injection: the data plane needs neither (narrower
    // credential surface than every other agentarts tool).
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, undefined);
    assert.equal(childEnv.HUAWEICLOUD_SDK_SK, undefined);
    // The request JSON carries only non-secret params, region defaulted.
    const request = JSON.parse(args[args.length - 1]);
    assert.deepEqual(request, { operation: 'list_sessions', space_id: 'sp1', region: 'cn-southwest-2' });
  });
});

test('search_memories injects actor_id into the request filters', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    let request = null;
    const out = await readAgentartsMemory(
      {
        operation: 'search_memories',
        space_id: 'sp1',
        actor_id: 'user-7',
        filters: { query: 'deploy steps', top_k: 5, min_score: null },
      },
      {
        runCandidate: async (_candidate, args) => {
          request = JSON.parse(args[args.length - 1]);
          return { exitCode: 0, stdout: '{"records": []}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    // actor_id lands INSIDE filters (MemorySearchFilter shape) and null
    // filter values are dropped before the wire.
    assert.equal(request.filters.actor_id, 'user-7');
    assert.equal(request.filters.query, 'deploy steps');
    assert.equal(request.filters.top_k, 5);
    assert.equal('min_score' in request.filters, false);
  });
});

test('memory read redacts parsed results and masks failure output', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    // A credential-shaped field on a parsed result must not ride the one
    // parse-first surface (trap 27 class).
    const out = await readAgentartsMemory(
      { operation: 'get_memory', space_id: 'sp1', memory_id: 'm1' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: '{"id": "m1", "content": "prefers tabs", "api_key": "LEAKY998"}',
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.result.api_key, '<redacted>');
    assert.equal(out.result.content, 'prefers tabs');
    assert.doesNotMatch(JSON.stringify(out), /LEAKY998/);
    assert.doesNotMatch(JSON.stringify(out), /KEY_ONETIME_mem42/);

    // exit 1 + traceback on stderr: failure detected from OUR exit code
    // (the snippet contract), stderr redacted in the payload.
    const failure = await readAgentartsMemory(
      { operation: 'list_sessions', space_id: 'sp1' },
      {
        runCandidate: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'Traceback (most recent call last):\nValueError: api_key=boom',
        }),
      },
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.failureDetected, true);
    assert.match(failure.stderr, /Traceback/);
    assert.match(failure.stderr, /api_key=<redacted>/);

    // exit 0 + unparseable stdout: pollution detector fires with an
    // explanatory error field.
    const polluted = await readAgentartsMemory(
      { operation: 'list_sessions', space_id: 'sp1' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: 'not json at all', stderr: '' }),
      },
    );
    assert.equal(polluted.ok, false);
    assert.equal(polluted.failureDetected, true);
    assert.match(polluted.error, /not parseable JSON — output pollution suspected/);
  });
});

test('module-missing advances the python candidate chain; spawn errors do not leak the key', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const candidates = [];
    const out = await readAgentartsMemory(
      { operation: 'list_messages', space_id: 'sp1', session_id: 's1' },
      {
        runCandidate: async (candidate) => {
          candidates.push(candidate);
          if (candidates.length === 1) return { exitCode: 3, stdout: '', stderr: 'AGENTARTS_SDK_MISSING' };
          return { exitCode: 0, stdout: '{"items": [], "total": 0}', stderr: '' };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(candidates.length, 2);

    const spawnErr = await readAgentartsMemory(
      { operation: 'list_messages', space_id: 'sp1', session_id: 's1' },
      {
        runCandidate: async () => ({ exitCode: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') }),
      },
    );
    // All candidates spawn-failed: the install remediation, key never echoed.
    assert.equal(spawnErr.ok, false);
    assert.match(spawnErr.error, /install-agentarts/);
    assert.doesNotMatch(JSON.stringify(spawnErr), /KEY_ONETIME_mem42/);
  });
});

test('traceback-bearing memory CONTENT reads as success (no content signature scan)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    // Memory content is by design a store of failure experience — episodic
    // memories about debugging carry tracebacks and ERROR log lines. A
    // content-signature failure scan would permanently report these
    // successful reads as failures (adversarial round-1 finding). The
    // failure contract is exit codes + stdout parseability only.
    const out = await readAgentartsMemory(
      { operation: 'list_memories', space_id: 'sp1' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                id: 'm1',
                content:
                  '2026-10-21 12:00:00 - ERROR - build failed; Traceback (most recent call last): ... TypeError: boom',
              },
            ],
            total: 1,
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.failureDetected, false);
    assert.match(out.result.items[0].content, /Traceback/);
  });
});

test('large memory results truncate to a pointer like the CLI wrapper', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const big = JSON.stringify({ items: [{ id: 'm', content: 'x'.repeat(100) }], total: 700, pad: 'y'.repeat(60000) });
    const out = await readAgentartsMemory(
      { operation: 'list_memories', space_id: 'sp1', limit: 100 },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: big, stderr: '' }),
      },
    );
    assert.equal(out.ok, true);
    assert.match(out.stdout, /truncated, full output saved to/);
    // When the side file fires, `result` is DROPPED — an untruncated parsed
    // object next to a truncated stdout would defeat the machinery.
    assert.equal('result' in out, false);
    const saved = out.stdout.match(/saved to (.+?)\)\s*$/)?.[1];
    assert.ok(saved && existsSync(saved));
    // The side file is scrubbed (no key anywhere) and 0600.
    const content = readFileSync(saved, 'utf8');
    assert.ok(!content.includes(KEY));
    assert.ok(out.stdout.length < big.length);
  });
});

test('memory read tool surface: definition and dispatch', async () => {
  await withIsolation(async () => {
    const definition = AGENTARTS_MEMORY_TOOL_DEFINITIONS[0];
    assert.equal(definition.name, 'huaweicloud_agentarts_memory_read');
    // The tool must NEVER accept an api_key parameter — the key channel is
    // the 0600 file, read server-side.
    assert.equal('api_key' in definition.inputSchema.properties, false);
    assert.equal(definition.inputSchema.required.join(','), 'operation,space_id');
    // Definitions carry no handlers (dispatch lives in the call function).
    assert.equal('handler' in definition, false);

    // Dispatch routing (no spawn: invalid params stop at the boundary).
    const rejected = await callAgentartsMemoryTool('huaweicloud_agentarts_memory_read', {
      operation: 'list_sessions',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /space_id must match/);
    const unknown = await callAgentartsMemoryTool('huaweicloud_agentarts_memory_bogus', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unknown agentarts memory tool/);
  });
});

test('the read operation set is exactly the 8 data-plane readonly methods', () => {
  assert.deepEqual(
    [...MEMORY_READ_OPERATIONS].sort((a, b) => a.localeCompare(b)),
    [
      'get_last_k_messages',
      'get_memory',
      'get_message',
      'get_session',
      'list_memories',
      'list_messages',
      'list_sessions',
      'search_memories',
    ],
  );
});

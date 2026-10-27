import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readAgentartsMemory,
  planAgentartsMemoryWrite,
  runAgentartsMemoryWrite,
  callAgentartsMemoryTool,
  AGENTARTS_MEMORY_TOOL_DEFINITIONS,
  AGENTARTS_MEMORY_WRITE_TOOL_DEFINITIONS,
  MEMORY_READ_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-memory.mjs';
import { planAgentartsCommand } from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

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
    // filters on the six non-filter operations: rejected as inapplicable,
    // not silently ignored (the same silent-no-op class).
    await bad(
      { operation: 'get_memory', space_id: 'sp1', memory_id: 'm1', filters: { strategy_type: 'semantic' } },
      /"filters" is not a parameter of get_memory/,
    );
    // A legal key in the WRONG operation is rejected (actor_id with
    // list_memories wants filters.actor_id).
    await bad(
      { operation: 'list_memories', space_id: 'sp1', actor_id: 'u1' },
      /"actor_id" is not a parameter of list_memories/,
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

test('search_memories success carries a numeric score digest (searchSummary)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    // MemorySearchResponse shape (pinned venv config.py:874-899):
    // {results: [{record, score}], total, query}.
    const out = await readAgentartsMemory(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { query: 'deploy' } },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            results: [
              { record: { id: 'm1' }, score: 0.0001 },
              { record: { id: 'm2' }, score: 0.042 },
              { record: { id: 'm3' }, score: 0.06 },
            ],
            total: 3,
            query: 'deploy',
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true);
    // The digest is pure numbers: relevance signal without a content scan.
    assert.deepEqual(out.searchSummary, { resultCount: 3, maxScore: 0.06, minScore: 0.0001 });
    // Non-search reads never grow a searchSummary.
    const plain = await readAgentartsMemory(
      { operation: 'list_sessions', space_id: 'sp1' },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"items": []}', stderr: '' }),
      },
    );
    assert.equal(plain.ok, true);
    assert.equal('searchSummary' in plain, false);
    // Scoreless search results: count-only digest, no NaN leakage.
    const scoreless = await readAgentartsMemory(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { query: 'deploy' } },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ results: [{ record: { id: 'm1' } }], total: 1, query: 'deploy' }),
          stderr: '',
        }),
      },
    );
    assert.deepEqual(scoreless.searchSummary, { resultCount: 1 });
    // Failed searches grow no digest.
    const failedSearch = await readAgentartsMemory(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { query: 'deploy' } },
      {
        runCandidate: async () => ({ exitCode: 1, stdout: '', stderr: 'ValueError: boom' }),
      },
    );
    assert.equal(failedSearch.ok, false);
    assert.equal('searchSummary' in failedSearch, false);
  });
});

test('searchSummary survives large-output truncation (result drops, digest stays)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    // >50,000 chars of parseable search JSON: the side file fires, the
    // parsed result is dropped (the file pointer is the contract) — the
    // three-number digest is exactly what a too-big result list needs.
    const padding = 'x'.repeat(60_000);
    const out = await readAgentartsMemory(
      { operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters: { query: 'deploy' } },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            results: [
              { record: { id: 'm1', blob: padding }, score: 0.01 },
              { record: { id: 'm2', blob: padding }, score: 0.05 },
            ],
            total: 2,
            query: 'deploy',
          }),
          stderr: '',
        }),
      },
    );
    assert.equal(out.ok, true);
    assert.match(out.stdout, /truncated, full output saved to/);
    assert.equal('result' in out, false);
    assert.deepEqual(out.searchSummary, { resultCount: 2, maxScore: 0.05, minScore: 0.01 });
  });
});

test('a set filters.min_score is enforced CLIENT-side (server-side filter measured ineffective)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const search = (filters, runCandidate) =>
      readAgentartsMemory({ operation: 'search_memories', space_id: 'sp1', actor_id: 'u1', filters }, { runCandidate });
    const fullResponse = {
      exitCode: 0,
      stdout: JSON.stringify({
        results: [
          { record: { id: 'm1' }, score: 0.000016 },
          { record: { id: 'm2' }, score: 0.042 },
          { record: { id: 'm3' }, score: 0.14 },
        ],
        total: 3,
        query: 'deploy',
      }),
      stderr: '',
    };
    // min_score=0.01 (the measured trap-31 shape: the server returned
    // sub-threshold entries anyway). The bridge cuts them from `result`
    // and reports the cut — searchSummary still describes the RAW set.
    const cut = await search({ query: 'deploy', top_k: 10, min_score: 0.01 }, async () => fullResponse);
    assert.equal(cut.ok, true);
    assert.deepEqual(
      cut.result.results.map((r) => r.record.id),
      ['m2', 'm3'],
    );
    assert.deepEqual(cut.searchSummary, { resultCount: 3, maxScore: 0.14, minScore: 0.000016 });
    assert.ok(cut.notes.length >= 1);
    assert.match(cut.notes[0], /removed 1 of 3 server-returned entries CLIENT-side/);
    assert.match(cut.notes[0], /server-side filter is ineffective even when set/);
    assert.match(cut.notes[0], /searchSummary describes the RAW response/);
    // Everything above threshold: no note, result untouched.
    const noCut = await search({ query: 'deploy', min_score: 0.00001 }, async () => fullResponse);
    assert.equal(noCut.ok, true);
    assert.equal(noCut.result.results.length, 3);
    assert.equal('notes' in noCut, false);
    // Entries without a finite score are KEPT (not-below-threshold is
    // not a judgement the bridge can make for the server).
    const scoreless = await search({ query: 'deploy', min_score: 0.01 }, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        results: [
          { record: { id: 'no-score' } },
          { record: { id: 'm2' }, score: 0.042 },
          { record: { id: 'm1' }, score: 0.000016 },
        ],
        total: 3,
        query: 'deploy',
      }),
      stderr: '',
    }));
    assert.equal(scoreless.ok, true);
    assert.deepEqual(
      scoreless.result.results.map((r) => r.record.id),
      ['no-score', 'm2'],
    );
    // min_score: null (dropped from the request) never triggers the
    // client-side filter.
    const nullMin = await search({ query: 'deploy', min_score: null }, async () => fullResponse);
    assert.equal(nullMin.ok, true);
    assert.equal(nullMin.result.results.length, 3);
    assert.equal('notes' in nullMin, false);
    // A numeric STRING threshold coerces (validation does not type-check
    // filter values; the request would carry the string server-side).
    const stringMin = await search({ query: 'deploy', min_score: '0.01' }, async () => fullResponse);
    assert.equal(stringMin.ok, true);
    assert.deepEqual(
      stringMin.result.results.map((r) => r.record.id),
      ['m2', 'm3'],
    );
    // min_score set but the response is unparseable (failure): no filter
    // path, no note — failure contract owns the payload.
    const failedSearch = await search({ query: 'deploy', min_score: 0.01 }, async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ValueError: boom',
    }));
    assert.equal(failedSearch.ok, false);
    assert.equal('notes' in failedSearch, false);
  });
});

test('unscoped list_sessions/list_memories results carry an all-actors note', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const run = (operation, extra) =>
      readAgentartsMemory(
        { operation, space_id: 'sp1', ...extra },
        {
          runCandidate: async () => ({ exitCode: 0, stdout: '{"items": []}', stderr: '' }),
        },
      );
    // list_sessions without actor_id: every actor's sessions.
    const unscopedSessions = await run('list_sessions');
    assert.equal(unscopedSessions.ok, true);
    assert.ok(unscopedSessions.notes.length >= 1);
    assert.match(unscopedSessions.notes[0], /results span EVERY actor in the space/);
    assert.match(unscopedSessions.notes[0], /Scope with actor_id/);
    // Scoped: no note.
    const scopedSessions = await run('list_sessions', { actor_id: 'u1' });
    assert.equal(scopedSessions.ok, true);
    assert.equal('notes' in scopedSessions, false);
    // list_memories without filters.actor_id: every actor's memories;
    // the note names the filters form (the top-level actor_id is NOT a
    // list_memories parameter — rejected at the boundary).
    const unscopedMemories = await run('list_memories');
    assert.equal(unscopedMemories.ok, true);
    assert.match(unscopedMemories.notes[0], /Scope with filters\.actor_id/);
    const scopedMemories = await run('list_memories', { filters: { actor_id: 'u1' } });
    assert.equal(scopedMemories.ok, true);
    assert.equal('notes' in scopedMemories, false);
    // Non-list reads never grow the note.
    const single = await run('get_memory', { memory_id: 'm1' });
    assert.equal(single.ok, true);
    assert.equal('notes' in single, false);
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
    // The limit/top_k contract is discoverable without a failed call
    // (friction A2): limit's description excludes search_memories…
    assert.match(definition.inputSchema.properties.limit.description, /NOT a parameter of search_memories/);
    assert.match(definition.inputSchema.properties.limit.description, /filters\.top_k/);
    // …the search semantics (no default cutoff, whole space ranked, score
    // range as the relevance signal) live in the description and filters.
    assert.match(definition.description, /NO score cutoff/);
    assert.match(definition.description, /searchSummary score range/);
    assert.match(definition.inputSchema.properties.filters.description, /omitted min_score = NO score cutoff/);
    // U6: a SET min_score is documented as client-side enforced (the
    // server-side filter is measured-ineffective — trap 31).
    assert.match(definition.description, /enforced CLIENT-side by this bridge/);
    assert.match(definition.description, /server-side filter is measured-ineffective/);
    assert.match(definition.inputSchema.properties.filters.description, /the bridge filters CLIENT-side/);
    // U6: actor_id position contracts are discoverable in the WRITE tool
    // definitions (add_messages takes it per-message, top-level rejected).
    const planDef = AGENTARTS_MEMORY_WRITE_TOOL_DEFINITIONS.find((d) => d.name === 'huaweicloud_agentarts_memory_plan');
    const writeDef = AGENTARTS_MEMORY_WRITE_TOOL_DEFINITIONS.find(
      (d) => d.name === 'huaweicloud_agentarts_memory_write',
    );
    for (const def of [planDef, writeDef]) {
      assert.match(def.inputSchema.properties.actor_id.description, /inside each message/);
      assert.match(def.inputSchema.properties.actor_id.description, /not an add_messages parameter/);
    }

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

test('memory write plan validates the boundary (write-specific rules)', async () => {
  await withIsolation(async () => {
    const bad = async (params, pattern) => {
      const out = await planAgentartsMemoryWrite(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.error, pattern);
    };
    await bad(
      { operation: 'list_sessions', space_id: 'sp1' },
      /operation must be one of: create_session, add_messages, delete_session, delete_memory/,
    );
    await bad({ operation: 'create_session', space_id: 'sp1' }, /actor_id is REQUIRED for create_session/);
    await bad(
      { operation: 'add_messages', space_id: 'sp1', session_id: 's1', messages: [] },
      /messages must be a non-empty array/,
    );
    await bad(
      { operation: 'add_messages', space_id: 'sp1', session_id: 's1', messages: [{ role: 'tool', content: 'x' }] },
      /role must be one of user, assistant, system/,
    );
    await bad(
      { operation: 'add_messages', space_id: 'sp1', session_id: 's1', messages: [{ role: 'user', content: '' }] },
      /content must be a non-empty string/,
    );
    await bad(
      {
        operation: 'add_messages',
        space_id: 'sp1',
        session_id: 's1',
        messages: [{ role: 'user', content: 'x', meta: 5 }],
      },
      /messages\[0\]\.meta must be a string/,
    );
    await bad({ operation: 'delete_session', space_id: 'sp1' }, /session_id is required for delete_session/);
    await bad({ operation: 'delete_memory', space_id: 'sp1' }, /memory_id is required for delete_memory/);
    await bad(
      {
        operation: 'add_messages',
        space_id: 'sp1',
        session_id: 's1',
        messages: [{ role: 'user', content: 'x' }],
        timestamp: 1.5,
      },
      /timestamp must be an integer/,
    );
    // A legal key in the WRONG operation is rejected (top-level meta
    // belongs to create_session, not add_messages).
    await bad(
      {
        operation: 'add_messages',
        space_id: 'sp1',
        session_id: 's1',
        messages: [{ role: 'user', content: 'x' }],
        meta: { note: 'wrong level' },
      },
      /"meta" is not a parameter of add_messages/,
    );
  });
});

test('memory write plan mints a bound token with the right labels', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const plan = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [
        { role: 'user', content: 'we decided on tabs' },
        { role: 'assistant', content: 'noted' },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.tier, 'approved');
    assert.deepEqual(plan.labels, []);
    assert.equal(typeof plan.approvalToken, 'string');
    assert.equal(plan.request.messages.length, 2);
    assert.equal(plan.request.region, 'cn-southwest-2');
    assert.match(plan.approvalNote, /binds them exactly/);

    const del = planAgentartsMemoryWrite({ operation: 'delete_memory', space_id: 'sp1', memory_id: 'm9' });
    assert.equal(del.ok, true);
    assert.deepEqual(del.labels, ['irreversible']);

    const soft = planAgentartsMemoryWrite({ operation: 'delete_session', space_id: 'sp1', session_id: 's1' });
    assert.deepEqual(soft.labels, []);
  });
});

test('memory write enforces the token lifecycle and exact-parameter binding', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const messages = [{ role: 'user', content: 'we decided on tabs' }];
    const params = { operation: 'add_messages', space_id: 'sp1', session_id: 's1', messages };
    const plan = planAgentartsMemoryWrite(params);
    assert.equal(plan.ok, true);

    // No attestation → the repo's three-element contract throws.
    await assert.rejects(
      () => runAgentartsMemoryWrite({ ...params, approvalToken: plan.approvalToken }),
      /approvedByUser must be true/,
    );

    // No token → remediation points at the plan tool.
    const noToken = await runAgentartsMemoryWrite({ ...params, approvedByUser: true });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /approvalToken is required/);

    // Different parameters → binding mismatch, token NOT consumed.
    const changed = await runAgentartsMemoryWrite(
      {
        ...params,
        approvedByUser: true,
        approvalToken: plan.approvalToken,
        messages: [{ role: 'user', content: 'DIFFERENT' }],
      },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'CONFIRM_TOKEN_MISMATCH');
    assert.match(changed.error, /DIFFERENT parameters/);
    const recheck = await runAgentartsMemoryWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '{"items": []}', stderr: '' }),
      },
    );
    assert.equal(recheck.ok, true, 'token must stay valid for the original parameters after a mismatch rejection');

    // Replay after a successful execution → idempotent already_processed
    // (the D4-24 vocabulary: a consumed token reads "stop", never "re-plan
    // and duplicate the write").
    const replay = await runAgentartsMemoryWrite({
      ...params,
      approvedByUser: true,
      approvalToken: plan.approvalToken,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.outcome, 'already_processed');
    assert.match(replay.note, /Verify with huaweicloud_agentarts_memory_read/);
  });
});

test('memory write executes with the key env-only and redacts results', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const params = {
      operation: 'create_session',
      space_id: 'sp1',
      actor_id: 'user-7',
    };
    const plan = planAgentartsMemoryWrite(params);
    assert.equal(plan.ok, true);
    const seen = [];
    const out = await runAgentartsMemoryWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate, args, childEnv, stdinData) => {
          seen.push({ args, childEnv, stdinData });
          return {
            exitCode: 0,
            stdout: '{"id": "sess-1", "actor_id": "user-7", "api_key": "LEAKY777"}',
            stderr: '',
          };
        },
      },
    );
    assert.equal(out.ok, true);
    assert.equal(out.result.id, 'sess-1');
    assert.equal(out.result.api_key, '<redacted>');
    // Env-only key transport, no AK/SK.
    assert.equal(seen[0].childEnv.HUAWEICLOUD_SDK_MEMORY_API_KEY, KEY);
    assert.ok(!seen[0].args.some((a) => String(a).includes(KEY)));
    assert.equal(seen[0].childEnv.HUAWEICLOUD_SDK_AK, undefined);
    // The WRITE request rides STDIN (argv limit + process-list exposure),
    // never argv: args are exactly ['-c', <snippet>] and no user DATA
    // value appears in them (the snippet's own source mentions field
    // names — that is code, not data).
    const request = JSON.parse(seen[0].stdinData);
    assert.equal(request.actor_id, 'user-7');
    assert.equal(seen[0].args.length, 2);
    assert.ok(!seen[0].args.some((a) => String(a).includes('user-7')));
    assert.doesNotMatch(JSON.stringify(out), /LEAKY777|KEY_ONETIME_mem42/);
  });
});

test('memory write dispatch routes plan and write', async () => {
  await withIsolation(async () => {
    const rejected = await callAgentartsMemoryTool('huaweicloud_agentarts_memory_write', {
      operation: 'delete_memory',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /space_id must match/);
    const routed = await callAgentartsMemoryTool('huaweicloud_agentarts_memory_plan', {
      operation: 'delete_memory',
      space_id: 'sp1',
    });
    assert.equal(routed.ok, false);
    assert.match(routed.error, /memory_id is required/);
  });
});

test('memory write plan warns on credential-shaped message content (loud storage)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const clean = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'we decided on tabs for this repo' }],
    });
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.warnings, []);

    const risky = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'the api_key is AKIA123 and password=Secret99' }],
    });
    assert.equal(risky.ok, true);
    assert.equal(risky.warnings.length, 1);
    assert.match(risky.warnings[0], /credential shapes/);
  });
});

test('memory write canonicalizes meta key order (binding is semantic, not byte-luck)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const plan = planAgentartsMemoryWrite({
      operation: 'create_session',
      space_id: 'sp1',
      actor_id: 'u1',
      meta: { alpha: 1, beta: 2 },
    });
    assert.equal(plan.ok, true);
    // Same meta, different key order → the SAME canonical request binds.
    const out = await runAgentartsMemoryWrite(
      {
        operation: 'create_session',
        space_id: 'sp1',
        actor_id: 'u1',
        approvedByUser: true,
        approvalToken: plan.approvalToken,
        meta: { beta: 2, alpha: 1 },
      },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{"id": "s9"}', stderr: '' }) },
    );
    assert.equal(out.ok, true);
  });
});

test('memory write rejects unknown message keys (no silent no-ops)', async () => {
  await withIsolation(async () => {
    const out = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'x', tyop_filed: 'oops' }],
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /unknown key "tyop_filed"/);
  });
});

test('a CLI approval token can never authorize an SDK memory write (namespace separation)', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Mint a token in the agentarts CLI namespace for the SAME-looking
    // operation text; the SDK write must reject it as not_found.
    const cliPlan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    assert.equal(cliPlan.ok, true);
    const out = await runAgentartsMemoryWrite(
      {
        operation: 'create_session',
        space_id: 'sp1',
        actor_id: 'u1',
        approvedByUser: true,
        approvalToken: cliPlan.approvalToken,
      },
      { runCandidate: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    );
    assert.equal(out.ok, false);
    assert.equal(out.code, 'CONFIRM_TOKEN_NOT_FOUND');
    assert.match(out.error, /different namespace/);
  });
});

test('failed write executions say the token burned, with idempotency_key guidance', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const params = {
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'batch one' }],
    };
    for (const [label, outcome] of [
      ['exit-1', { exitCode: 1, stdout: '', stderr: 'ValueError: boom' }],
      ['timeout', { exitCode: null, stdout: '', stderr: '', timedOut: true }],
    ]) {
      // Each variant gets its OWN plan: the first failure consumes the
      // token, and a shared one would turn the second into
      // already_processed.
      const plan = planAgentartsMemoryWrite(params);
      assert.equal(plan.ok, true, label);
      const out = await runAgentartsMemoryWrite(
        { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
        { runCandidate: async () => outcome },
      );
      assert.equal(out.ok, false, label);
      assert.match(out.error, /single-use token was consumed by this attempt/, label);
      assert.match(out.error, /idempotency_key/, label);
      if (outcome.timedOut) assert.match(out.error, /timeout that may have landed server-side/, label);
    }
  });
});

test('unknown top-level write/read parameters are rejected, not silently dropped', async () => {
  await withIsolation(async () => {
    // A typo'd idempotencykey would silently disarm the duplicate-write
    // guard the retry guidance relies on.
    const typo = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'x' }],
      idempotencykey: 'retry-1',
    });
    assert.equal(typo.ok, false);
    assert.match(typo.error, /Unknown parameter "idempotencykey"/);

    const readTypo = await readAgentartsMemory({ operation: 'list_sessions', space_id: 'sp1', limt: 5 });
    assert.equal(readTypo.ok, false);
    assert.match(readTypo.error, /Unknown parameter "limt"/);
  });
});

test('credential-shape warning covers session/message metadata too', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const sessionMeta = planAgentartsMemoryWrite({
      operation: 'create_session',
      space_id: 'sp1',
      actor_id: 'u1',
      meta: { note: 'password=Secret99' },
    });
    assert.equal(sessionMeta.ok, true);
    assert.equal(sessionMeta.warnings.length, 1);

    const messageMeta = planAgentartsMemoryWrite({
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'plain text', meta: 'api_key: AKIA999' }],
    });
    assert.equal(messageMeta.ok, true);
    assert.equal(messageMeta.warnings.length, 1);

    const innocuous = planAgentartsMemoryWrite({
      operation: 'create_session',
      space_id: 'sp1',
      actor_id: 'u1',
      meta: { project: 'demo', owner: 'team-x' },
    });
    assert.deepEqual(innocuous.warnings, []);
  });
});

test('a RUNTIME ModuleNotFoundError is a final failure, not a chain advance', async () => {
  await withIsolation(async (home) => {
    writeKeyFile(home, 'sp1', KEY);
    const params = {
      operation: 'add_messages',
      space_id: 'sp1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'x' }],
    };
    const plan = planAgentartsMemoryWrite(params);
    const candidates = [];
    const out = await runAgentartsMemoryWrite(
      { ...params, approvedByUser: true, approvalToken: plan.approvalToken },
      {
        runCandidate: async (candidate) => {
          candidates.push(candidate);
          // A runtime import failure INSIDE the SDK (exit 1 via the scoped
          // handler): the loop must NOT advance the chain and must NOT
          // print the install-the-SDK remediation — and the burn note must
          // survive.
          return { exitCode: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'yaml'" };
        },
      },
    );
    assert.equal(out.ok, false);
    assert.equal(candidates.length, 1, 'runtime module errors must not advance the candidate chain');
    assert.doesNotMatch(out.error, /install-agentarts/);
    assert.match(out.error, /single-use token was consumed by this attempt/);
  });
});

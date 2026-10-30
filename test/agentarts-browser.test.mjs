import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentartsBrowser, callAgentartsBrowserTool } from '../plugins/huaweicloud-core/src/agentarts-browser.mjs';
import {
  AGENTARTS_BROWSER_TOOL_DEFINITIONS,
  BROWSER_READ_OPERATIONS,
} from '../plugins/huaweicloud-core/src/agentarts-browser-tools.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('browser read without credentials neutralizes the profile chain (env-or-fail posture)', async () => {
  await withIsolation(async () => {
    clearRuntimeCredentials();
    let childEnv = null;
    const out = await readAgentartsBrowser(
      { operation: 'list_browsers' },
      {
        runCandidate: async (candidate, args, env) => {
          childEnv = env;
          return { exitCode: 1, stdout: '', stderr: 'ToolsAPIError: authentication failed' };
        },
      },
    );
    assert.equal(out.ok, false);
    // No AK/SK reached the child and the profile fallback is pinned to
    // /dev/null — the child can never silently authenticate from an
    // unmanaged profile (the wrapper contract).
    assert.equal(childEnv.HUAWEICLOUD_SDK_AK, undefined);
    assert.equal(childEnv.HUAWEICLOUD_SDK_SK, undefined);
    assert.equal(childEnv.HUAWEICLOUD_SDK_CREDENTIALS_FILE, '/dev/null');
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
      { operation: 'get_browser', browser_id: 'b1' },
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
        runCandidate: async () => ({ exitCode: 0, stdout: JSON.stringify(iamOnly), stderr: '' }),
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
        runCandidate: async () => ({ exitCode: 0, stdout: JSON.stringify(apiKeyTyped), stderr: '' }),
      },
    );
    assert.equal(advised.ok, true);
    assert.ok(advised.notes.length >= 1);
    assert.match(advised.notes[0], /API_KEY-typed browser/);
    assert.match(advised.notes[0], /trap 61/);

    // get_browser shape (single dict, not an items array).
    const got = await readAgentartsBrowser(
      { operation: 'get_browser', browser_id: 'b2' },
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ id: 'b2', name: 'br-2', auth_type: 'API_KEY' }),
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

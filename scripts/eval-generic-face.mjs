#!/usr/bin/env node
// Eval harness for the single generic call face. Before the face
// consolidation the devkit shipped six first-class discovery proxies
// alongside huaweicloud_gateway_call; they were deleted so classify() is
// the single approval choke point. What this harness measures now: per
// task, tool-call count and outcome, driving the REAL callTool dispatch
// against the REAL gateway binary in openapi,data mode.
//
// Usage: node scripts/eval-generic-face.mjs [--json]
//
// Face accounting (delegation face): consent is the gateway policy
// engine's business, so a state-changing call is ONE dispatch — forward,
// and either the engine grants it or the refusal reason teaches the grant
// flow. The face's structural cost for an agent that knows no names is
// the NAME-DISCOVERY call (gateway_list_tools) — modeled ONCE PER
// SESSION. Zero-cost paths, in order of reach: (1) an agent that loaded
// huawei-openapi knows the names statically; (2) an agent that reads tool
// descriptions also knows them — huaweicloud_gateway_call's description
// carries all six readonly names and the chain (structure.test.ts pins
// that content). The +1 therefore bounds only an agent that skips BOTH:
// the upper bound of the unskilled face, not its typical cost.
//
// Preflight: the gateway binary must resolve and complete a handshake, or
// the harness exits non-zero with a loud error — a green table must never
// be producible from absence.
//
// Timing note: the sidecar is warm across tasks (spawn/handshake
// excluded); calls, not ms, are the decision metric.

import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const asJson = process.argv.includes('--json');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const gatewayBin = process.env.OPENMCP_BIN || join(homedir(), '.local/bin/huaweicloud-open-mcp');

if (!existsSync(gatewayBin)) {
  console.error(
    `eval-generic-face: gateway binary not found at ${gatewayBin} (set OPENMCP_BIN). Refusing to produce evidence from absence.`,
  );
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'openmcp-eval-'));
process.env.HUAWEICLOUD_HOME = home;
process.env.HUAWEICLOUD_MCP_MODE = 'openapi,data';
process.env.OPENMCP_BIN = gatewayBin;

const { callTool } = await import(join(repoRoot, 'plugins/huaweicloud-core/src/tools.ts'));
const { _resetOpenMcpSidecar } = await import(
  join(repoRoot, 'plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts')
);

// Preflight: one real dispatch must reach the gateway (spawn + handshake +
// proxy round trip). Any failure here aborts before a table exists.
await _resetOpenMcpSidecar();
const preflight = await callTool('huaweicloud_gateway_list_tools', {});
if (preflight.ok !== true) {
  console.error(`eval-generic-face: gateway preflight failed: ${JSON.stringify(preflight).slice(0, 200)}`);
  process.exit(1);
}

// Each task is ONE gateway_call dispatch. Post-consolidation every
// gateway tool name is discovery-needing for an unskilled agent, so the
// harness lists once per session before the first dispatch and charges
// the +1 there (round-10's per-task needsDiscovery field died with the
// first-class faces it measured against).
const TASKS = [
  {
    id: 'read-discovery',
    run: () => callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: { query: 'ecs', limit: 1 } }),
  },
  {
    id: 'generic-data-query',
    run: () => callTool('huaweicloud_gateway_call', { tool: 'query_data', toolArgs: { sql: 'select 1 as x' } }),
  },
  {
    // The engine refuses an ungranted execute and its reason teaches the
    // grant flow; reached-and-refused is the expected outcome row.
    id: 'generic-execute',
    run: () =>
      callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: { product: 'IAM', api: 'KeystoneListRegions' },
      }),
  },
];

// The unskilled agent lists ONCE per session: the first call triggers the
// listing; later tasks reuse the knowledge (round-10: per-task listing
// overstated the session). Only the FIRST task carries the +1.
let listedThisSession = null;
let sessionDiscoveryCalls = 0;

const rows = [];
for (const task of TASKS) {
  let listCalls = 0;
  if (!listedThisSession) {
    const listing = await callTool('huaweicloud_gateway_list_tools', {});
    if (listing.ok !== true)
      throw new Error(`gateway_list_tools failed mid-eval: ${JSON.stringify(listing).slice(0, 120)}`);
    listedThisSession = listing;
    sessionDiscoveryCalls += 1;
    listCalls = 1;
  }
  const started = process.hrtime.bigint();
  const final = await task.run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // ok = the FACE reached the gateway. The wire envelope's `tool` field is
  // set only by callOpenMcpTool after a proxied round trip (sidecar.ts),
  // so it is the forwarding proof for every failure shape: the policy
  // envelope ({ok:false, reason}), the protocol-level isError envelope
  // ({ok:false, error} — a missing backend reports this way), and
  // successes alike. Devkit-side floor denials carry classification:'deny'
  // and no tool field, and spawn failures carry neither — both stay
  // unreached, as they should.
  const reached = final.ok === true || (final.ok === false && typeof final.tool === 'string');
  rows.push({ task: task.id, calls: 1 + listCalls, ms: Math.round(ms), ok: reached });
}
await _resetOpenMcpSidecar();

if (asJson) {
  console.log(JSON.stringify({ rows, sessionDiscoveryCalls }, null, 2));
} else {
  console.log('task                        calls  ms     reached');
  for (const row of rows) {
    console.log(
      `${row.task.padEnd(28)}${String(row.calls).padStart(5)}  ${String(row.ms).padStart(5)}  ${row.ok ? 'yes' : 'NO'}`,
    );
  }
  console.log(`\nsession name-discovery calls (unskilled agent): ${sessionDiscoveryCalls}`);
  console.log('zero-cost paths: an agent that loaded huawei-openapi knows the names statically;');
  console.log('an agent that reads tool descriptions also knows them (gateway_call teaches all six readonly names).');
  console.log('the +1 bounds only an agent that skips both — the unskilled upper bound.');
}

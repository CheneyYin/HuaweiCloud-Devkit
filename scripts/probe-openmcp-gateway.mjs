#!/usr/bin/env node
// One-shot probe of the REAL huaweicloud-open-mcp gateway. Opt-in developer
// tooling, never run by the Node test suite (which points OPENMCP_BIN at the
// fixture). Settles the semantics the delegated approval face cites in its
// comments and docs:
//   - the empty-policy execute_api refusal (its consent-teaching tail)
//   - manage_policy add scope vocabulary (canonical spellings only)
//   - list order (overlay before file) and the policy echo on add/remove
//   - remove rejecting scope/ttl_seconds
//   - the once-burn target (LABELED LIMIT: executions against nonexistent
//     APIs stop at catalog resolution, so the burn target is observed only
//     when a real cloud call is possible)
// Run: node scripts/probe-openmcp-gateway.mjs   (PROBE_BIN overrides the
// binary; scratch policy/log files land in a temp dir printed at the end).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'openmcp-probe-'));
const policy = join(scratch, 'policy');
writeFileSync(policy, 'ECS:FromFile=allow\n');

const binSpec = process.env.PROBE_BIN ?? 'huaweicloud-open-mcp';
const [command, ...commandPrefix] = binSpec.split(' ');

// The gateway's argparse has no --version; the installed distribution knows
// its own version. Resolve the interpreter from the binary's shebang when
// possible (the uv-tool install shape) and ask importlib.metadata.
function gatewayVersion() {
  try {
    const firstLine = readFileSync(command, 'utf8').split('\n')[0];
    if (!firstLine.startsWith('#!')) return 'unknown';
    const interpreter = firstLine.slice(2).trim();
    return (
      execFileSync(interpreter, ['-c', "import importlib.metadata as m; print(m.version('huaweicloud-open-mcp'))"])
        .toString()
        .trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

const version = gatewayVersion();
console.log(`gateway binary: ${binSpec}`);
console.log(`gateway version: ${version}`);

const child = spawn(
  command,
  [
    ...commandPrefix,
    '--elicitation',
    'off',
    '--mode',
    'openapi',
    '--policy',
    policy,
    '--log-file',
    join(scratch, 'gateway.log'),
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
child.stderr.setEncoding('utf8');
let stderr = '';
child.stderr.on('data', (c) => {
  stderr += c;
});

let buffer = '';
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {
        /* noise */
      }
    }
    nl = buffer.indexOf('\n');
  }
});

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function text(result) {
  return result?.content?.map((c) => c.text)?.join('') ?? JSON.stringify(result);
}

async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  return text(result);
}

try {
  await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const step = async (label, name, args) => {
    const out = await call(name, args);
    console.log(`\n=== ${label} ===`);
    console.log(out);
  };

  await step('refusal with no matching rule (consent-teaching tail)', 'execute_api', {
    product: 'ECS',
    api: 'ProbeNoRule',
  });
  await step('add scope " ONCE "', 'manage_policy', { action: 'add', line: 'ECS:ProbeOnce=allow', scope: ' ONCE ' });
  await step('add scope "bogus"', 'manage_policy', { action: 'add', line: 'ECS:ProbeBogus=allow', scope: 'bogus' });
  await step('add scope "Once"', 'manage_policy', { action: 'add', line: 'ECS:ProbeOnce2=allow', scope: 'Once' });
  await step('add canonical once (overlay)', 'manage_policy', {
    action: 'add',
    line: 'ECS:OverlayRule=allow',
    scope: 'once',
  });
  await step('list (order + verbatim scope + file rule)', 'manage_policy', { action: 'list' });
  await step('remove carrying ttl_seconds', 'manage_policy', {
    action: 'remove',
    line: 'ECS:FromFile=allow',
    ttl_seconds: 3600,
  });
  await step('remove succeeding (file-layer hit) — envelope shape', 'manage_policy', {
    action: 'remove',
    line: 'ECS:FromFile=allow',
  });
  await step('list after the file-layer remove', 'manage_policy', { action: 'list' });
  await step('execute against the " ONCE " rule', 'execute_api', { product: 'ECS', api: 'ProbeOnce' });
  await step('list after execute of " ONCE " rule', 'manage_policy', { action: 'list' });
  await step('add canonical once A', 'manage_policy', { action: 'add', line: 'ECS:RuleA=allow', scope: 'once' });
  await step('add canonical once B', 'manage_policy', { action: 'add', line: 'ECS:RuleB=allow', scope: 'once' });
  await step('execute RuleA', 'execute_api', { product: 'ECS', api: 'RuleA' });
  await step('list after executing RuleA (which rule burned?)', 'manage_policy', { action: 'list' });
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000);
  console.log(`\nscratch dir (policy + gateway log): ${scratch}`);
  process.exit(0);
} catch (error) {
  console.error('PROBE FAILURE:', error.message);
  console.error('stderr tail:', stderr.slice(-2000));
  child.kill('SIGKILL');
  process.exit(1);
}

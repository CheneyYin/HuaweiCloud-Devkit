import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';

// AgentArts end-to-end acceptance (the PR4 deliverable): S0 preflight →
// S3 read-only cloud path → S5 golden path (init → dev → config → deploy →
// invoke → destroy) → S6 teardown + canary + report.
//
// Gated by a SINGLE switch: AGENTARTS_E2E=1. Plain `npm test` globs
// test/*.test.mjs and never loads this file; even a direct ungated run
// skips. Credentials come from ~/.config/agentarts-e2e/creds (0600, outside
// the worktree; variables AK and SK). The harness FAILS CLOSED:
//   - creds file missing/unreadable/mis-shaped → the gated run hard-fails;
//   - the E2E account fingerprint equals the machine's configured devkit
//     account → hard abort (the isolation invariant, via the toolkit's own
//     redacted fingerprint machinery);
//   - pre-existing e2e-aa-* memory-space OR agent leftovers → abort (adopt-or-abort; the agent sweep runs through the PR7 list-agents SDK tool — 0.1.7 has no list CLI command).
// Convergence: a failure anywhere after deploy triggers a FINALLY-DESTROY
// (best-effort, recorded in the report), and the 0600 report is ALWAYS
// written — success or failure. The PR4 blind spot (no agent listing, so
// leftovers were finally-destroy-only) is closed by the PR7 list-agents
// tool: the pre-sweep covers agents too, and destroy is verified by list
// disappearance, not just exit output.
// Design contract: docs/agentarts-pr0-findings.md + the E2E review rounds.

const GATE = process.env.AGENTARTS_E2E === '1';
const CREDS_PATH = join(homedir(), '.config', 'agentarts-e2e', 'creds');
const WORKTREE = join(import.meta.dirname, '..', '..', '..');
const SCRATCH_ROOT = join(WORKTREE, '.e2e-home');
const AGENTARTS_BIN = join(SCRATCH_ROOT, 'venv', 'bin', 'agentarts');

// Pin the wrapper stages to the scratch venv: the wrapper resolves
// AGENTARTS_BIN > devkit venv > PATH, and without this pin the S3/S5
// wrapper runs would silently depend on machine PATH state (the
// isolation gap found in the PR5 review — direct spawns above already
// used the constant; the wrapper path did not).
process.env.AGENTARTS_BIN = AGENTARTS_BIN;

function parseCreds() {
  const raw = readFileSync(CREDS_PATH, 'utf8');
  const creds = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) creds[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!creds.AK || !creds.SK) {
    throw new Error('creds file must define AK and SK (variable names, mapped to HUAWEICLOUD_SDK_AK/SK)');
  }
  return creds;
}

const runid = `e2e-aa-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const agentName = `${runid}-agent`;
const report = { runid, startedAt: new Date().toISOString(), stages: {}, approvals: 0, traps: [] };

async function stage(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.stages[name] = { ok: true, durationMs: Date.now() - startedAt, ...(detail || {}) };
  } catch (error) {
    report.stages[name] = { ok: false, durationMs: Date.now() - startedAt, error: String(error.message || error) };
    throw error;
  }
}

// The canary backstop: scan every captured artifact for the literal
// credential values. The wrapper redacts its outputs; this proves it end to
// end against the REAL values.
function canaryScan(artifacts, creds) {
  const hits = [];
  for (const [label, content] of Object.entries(artifacts)) {
    if (content && (content.includes(creds.AK) || content.includes(creds.SK))) {
      hits.push(label);
    }
  }
  return hits;
}

function scanTree(root, creds) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          const text = readFileSync(full, 'utf8');
          if (text.includes(creds.AK) || text.includes(creds.SK)) hits.push(full);
        } catch {
          /* binary/unreadable — skip */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

function writeReport() {
  report.finishedAt = new Date().toISOString();
  mkdirSync(join(SCRATCH_ROOT, 'e2e'), { recursive: true });
  const path = join(SCRATCH_ROOT, 'e2e', `report-${runid}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

test(
  'agentarts golden path e2e (S0 preflight → S3 readonly → S5 deploy lifecycle → S6 teardown)',
  { skip: !GATE ? 'set AGENTARTS_E2E=1 to run the gated cloud e2e' : false },
  async () => {
    const creds = parseCreds();
    let scratch;
    let projDir;
    let agentDir;
    let deployed = false;
    const artifacts = {};
    let planAgentartsCommand;
    let runAgentartsApprovedCommand;
    let listAgentartsAgents;

    try {
      // ---- S0: preflight -------------------------------------------------
      await stage('S0-preflight', async () => {
        assert.equal(statSync(CREDS_PATH).mode & 0o777, 0o600, 'creds file must be 0600');
        assert.ok(existsSync(AGENTARTS_BIN), `expected the scratch venv CLI at ${AGENTARTS_BIN}`);

        // Isolation invariant (fail-closed): the E2E account must differ from
        // the machine's configured devkit account. Compare REDACTED
        // fingerprints via the toolkit's own machinery — never the values.
        const { fingerprint } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'reconcile.mjs')
        );
        const { readGlobalCredentials } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'credentials.mjs')
        );
        const daily = readGlobalCredentials();
        if (daily?.ak && daily?.sk) {
          assert.notEqual(
            fingerprint(creds.AK, creds.SK),
            fingerprint(daily.ak, daily.sk),
            "E2E credentials match this machine's configured devkit account — refusing to run (isolation invariant)",
          );
        }

        // Docker (launch builds an image). In restricted networks docker.io is
        // unreachable — pre-pull the base image from a mirror and retag it so
        // `FROM python:3.10-slim` resolves locally (measured trap).
        const imageOk = await new Promise((resolve) => {
          const child = spawn('docker', ['images', 'python:3.10-slim', '-q'], { encoding: 'utf8' });
          let out = '';
          child.stdout.on('data', (c) => (out += c));
          child.on('close', () => resolve(out.trim().length > 0));
          child.on('error', () => resolve(false));
        });
        assert.ok(
          await new Promise((resolve) => {
            const child = spawn('docker', ['info'], { stdio: 'ignore' });
            child.on('close', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
          }),
          'docker daemon must be reachable for the deploy stage',
        );
        report.imagePrePulled = !imageOk;
        if (!imageOk) {
          await new Promise((resolve) => {
            const child = spawn('docker', ['pull', 'docker.1ms.run/library/python:3.10-slim'], { stdio: 'ignore' });
            child.on('close', () => resolve());
            child.on('error', () => resolve());
          });
          await new Promise((resolve) => {
            const child = spawn('docker', ['tag', 'docker.1ms.run/library/python:3.10-slim', 'python:3.10-slim'], {
              stdio: 'ignore',
            });
            child.on('close', () => resolve());
            child.on('error', () => resolve());
          });
        }

        // Scratch isolation: dedicated HOME + XDG + HUAWEICLOUD_HOME under
        // .e2e-home/e2e/<runid>/ so approvals.json, first-run completion
        // writes, and the project all land in scratch, never the real home.
        const e2eRoot = join(SCRATCH_ROOT, 'e2e');
        mkdirSync(e2eRoot, { recursive: true });
        scratch = mkdtempSync(join(e2eRoot, `${runid}-`));
        projDir = join(scratch, 'proj');
        mkdirSync(projDir, { recursive: true });
        agentDir = join(projDir, agentName);
        const envSwaps = {
          HOME: scratch,
          XDG_CONFIG_HOME: join(scratch, '.config'),
          XDG_CACHE_HOME: join(scratch, '.cache'),
          XDG_DATA_HOME: join(scratch, '.local', 'share'),
          HUAWEICLOUD_HOME: scratch,
          AGENTARTS_BIN,
        };
        for (const [key, value] of Object.entries(envSwaps)) {
          process.env[key] = value;
        }

        // Pre-sweep (adopt-or-abort): no e2e-aa-* memory-space leftovers, and
        // the scratch home must NOT contain a credentials profile (the
        // measured auth chain would silently authenticate from one).
        const { runAgentartsReadonlyCommand, listAgentartsAgents } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'agentarts-cli.mjs')
        );
        const { setRuntimeCredentials } = await import(
          join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'auth', 'credentials.mjs')
        );
        setRuntimeCredentials(creds.AK, creds.SK, undefined, 'cn-southwest-2');
        const preList = await runAgentartsReadonlyCommand([
          'memory',
          'list',
          '--region',
          'cn-southwest-2',
          '--output',
          'json',
        ]);
        assert.equal(preList.ok, true, `preflight memory list failed: ${preList.stderr || preList.error}`);
        const names = [...String(preList.stdout).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
        const leftovers = names.filter((n) => n.startsWith('e2e-aa-'));
        assert.deepEqual(
          leftovers,
          [],
          `pre-existing e2e-aa-* memory leftovers found — adopt or delete them first: ${leftovers.join(', ')}`,
        );

        // Agent pre-sweep (adopt-or-abort, e2e-aa- prefixed only — the
        // account's pre-existing agents are not ours to touch) through the
        // PR7 list-agents SDK tool. The same calls carry the S0 adjudication
        // items: SDK-default pagination semantics, the agent dict's field
        // shape, and the agent_name fuzzy-filter miss behavior.
        const agentsDefault = await listAgentartsAgents({});
        assert.equal(
          agentsDefault.ok,
          true,
          `preflight list-agents failed: ${agentsDefault.stderr || agentsDefault.error}`,
        );
        const agentsSweep = await listAgentartsAgents({ limit: 100 });
        assert.equal(agentsSweep.ok, true, `sweep list-agents failed: ${agentsSweep.stderr || agentsSweep.error}`);
        const agentNames = (agentsSweep.agents || []).map((a) => String(a?.name || '')).filter(Boolean);
        const agentLeftovers = agentNames.filter((n) => n.startsWith('e2e-aa-'));
        assert.deepEqual(
          agentLeftovers,
          [],
          `pre-existing e2e-aa-* agent leftovers found — adopt or delete them first: ${agentLeftovers.join(', ')}`,
        );
        const fuzzyMiss = await listAgentartsAgents({ agent_name: agentName });
        assert.equal(fuzzyMiss.ok, true);
        const sampleAgentKeys = agentsDefault.agents?.[0]
          ? Object.keys(agentsDefault.agents[0]).sort((a, b) => a.localeCompare(b))
          : [];
        assert.equal(
          existsSync(join(scratch, '.huaweicloud', 'credentials')),
          false,
          'scratch home must not carry a credentials profile (silent-auth isolation)',
        );
        return {
          scratch,
          projDir,
          memorySpaces: names.length,
          agentsDefaultPage: agentsDefault.count,
          agentsSweepCount: agentsSweep.count,
          fuzzyMissCount: fuzzyMiss.count,
          sampleAgentKeys,
        };
      });

      const { runAgentartsReadonlyCommand } = await import(
        join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'agentarts-cli.mjs')
      );
      ({ planAgentartsCommand, runAgentartsApprovedCommand, listAgentartsAgents } = await import(
        join(WORKTREE, 'plugins', 'huaweicloud-core', 'src', 'agentarts-cli.mjs')
      ));

      // ---- S3: read-only cloud path through the wrapper ------------------
      await stage('S3-readonly-cloud', async () => {
        const list = await runAgentartsReadonlyCommand([
          'memory',
          'list',
          '--region',
          'cn-southwest-2',
          '--output',
          'json',
        ]);
        artifacts['S3-memory-list'] = `${list.stdout}\n${list.stderr || ''}`;
        assert.equal(list.ok, true);
        assert.equal(list.failureDetected, false);
        const gateways = await runAgentartsReadonlyCommand(['gateway', 'list']);
        artifacts['S3-gateway-list'] = `${gateways.stdout}\n${gateways.stderr || ''}`;
        assert.equal(gateways.ok, true);
        // The PR7 SDK-API listing rides the same readonly cloud proof.
        const agents = await listAgentartsAgents({});
        artifacts['S3-list-agents'] = JSON.stringify({ ok: agents.ok, count: agents.count });
        assert.equal(agents.ok, true, `list-agents failed: ${agents.stderr || agents.error}`);
        assert.ok(Array.isArray(agents.agents), 'list-agents must return a parsed agents array');
        return {
          memoryListOk: list.ok,
          gatewayListOk: gateways.ok,
          listAgentsOk: agents.ok,
          listAgentsCount: agents.count,
        };
      });

      // ---- S5: golden path -------------------------------------------------
      async function approvedRun(args, options = {}) {
        // Plan and run with the SAME real args the harness constructed (no
        // secrets in them): the token binds to the canonical form, and these
        // already carry the non-interactive flags (destroy --yes) where
        // needed, so plan canonicalization is a no-op and the hash matches.
        const plan = planAgentartsCommand(args);
        assert.equal(plan.ok, true, `plan failed: ${plan.error}`);
        assert.equal(plan.tier, 'approved', `expected approved tier for ${args.join(' ')} (got ${plan.tier})`);
        report.approvals += 1;
        const result = await runAgentartsApprovedCommand({
          args,
          approvalToken: plan.approvalToken,
          approvedByUser: true,
          timeoutMs: options.timeoutMs,
          cwd: options.cwd ?? agentDir,
        });
        assert.equal(result.status, 'ok', `approved run rejected: ${JSON.stringify(result)}`);
        artifacts[`S5-${args[0]}-${args[1] || ''}`] =
          `${result.stdout || ''}\n${result.stderr || ''}\n${JSON.stringify(result.plan || {})}`;
        return result;
      }

      await stage('S5-init', async () => {
        // init is LOCAL tier: spawn directly in the scratch env (the wrapper
        // only handles readonly/approved; local is the Bash channel).
        const result = await new Promise((resolve) => {
          const child = spawn(
            AGENTARTS_BIN,
            [
              'init',
              '-n',
              agentName,
              '-t',
              'basic',
              '-r',
              'cn-southwest-2',
              '--swr-org',
              'e2e-aa',
              '--swr-repo',
              agentName,
              '-p',
              projDir,
            ],
            { cwd: projDir, env: { PATH: process.env.PATH, HOME: scratch }, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let out = '';
          child.stdout.on('data', (c) => (out += c));
          child.stderr.on('data', (c) => (out += c));
          child.on('close', (code) => resolve({ code, out }));
          child.on('error', (e) => resolve({ code: -1, out: String(e) }));
        });
        artifacts['S5-init'] = result.out;
        assert.ok(existsSync(join(agentDir, '.agentarts_config.yaml')), `init did not scaffold: ${result.out}`);
        // Restricted-network remediation (measured trap): the generated
        // Dockerfile pip-installs from pypi.org directly; point it at the
        // Huawei mirror so the in-build pip step can resolve.
        const dockerfilePath = join(agentDir, 'Dockerfile');
        const dockerfile = readFileSync(dockerfilePath, 'utf8');
        const pipIndex =
          process.env.AGENTARTS_E2E_PIP_INDEX || 'https://mirrors.huaweicloud.com/repository/pypi/simple';
        writeFileSync(
          dockerfilePath,
          dockerfile.replace(
            'RUN pip install --no-cache-dir -r requirements.txt',
            `RUN pip install --no-cache-dir -i ${pipIndex} -r requirements.txt`,
          ),
        );
        report.traps.push(
          'restricted networks: pre-pull the docker base image from a mirror and add a pip index to the Dockerfile (measured)',
        );
        report.traps.push('init requires -r (interactive region prompt otherwise — measured)');
        return { exitCode: result.code };
      });

      await stage('S5-dev-server', async () => {
        const port = 18000 + Math.floor(Math.random() * 2000);
        const child = spawn(AGENTARTS_BIN, ['dev', '--port', String(port)], {
          cwd: agentDir,
          env: { PATH: process.env.PATH, HOME: scratch },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let devLog = '';
        child.stdout.on('data', (c) => (devLog += c));
        child.stderr.on('data', (c) => (devLog += c));
        let healthy = false;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) });
            if (res.ok) {
              healthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        // Kill the whole process group and assert no survivor holds the port.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        await new Promise((r) => setTimeout(r, 1000));
        let survivor = false;
        try {
          await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1000) });
          survivor = true;
        } catch {
          /* gone — good */
        }
        artifacts['S5-dev'] = devLog;
        assert.ok(healthy, `dev server never became healthy on :${port}\n${devLog}`);
        assert.equal(survivor, false, 'dev server survived the process-group kill');
        return { port };
      });

      await stage('S5-config-set-region', async () => {
        const result = await approvedRun(['config', 'set', 'base.region', 'cn-southwest-2']);
        assert.equal(result.ok, true, `config set failed: ${result.stderr || result.error}`);
        const yaml = readFileSync(join(agentDir, '.agentarts_config.yaml'), 'utf8');
        artifacts['S5-config-yaml'] = yaml;
        assert.match(yaml, /region:\s*cn-southwest-2/);
        report.traps.push('config set rewrites the yaml (comments stripped, defaults materialized — measured)');
        return {};
      });

      deployed = true;
      await stage('S5-launch-deploy', async () => {
        const result = await approvedRun(['launch'], { timeoutMs: 600_000 });
        assert.equal(result.ok, true, `launch failed: ${(result.stderr || result.error || '').slice(0, 2000)}`);
        // The deployed agent is listed (SDK API). Listing may lag runtime
        // creation like invoke readiness does — small retry window.
        let listed = false;
        for (let attempt = 0; attempt < 3 && !listed; attempt += 1) {
          const check = await listAgentartsAgents({ agent_name: agentName });
          assert.equal(check.ok, true, `post-launch list-agents failed: ${check.stderr || check.error}`);
          listed = (check.agents || []).some((a) => a?.name === agentName);
          if (!listed && attempt < 2) await new Promise((r) => setTimeout(r, 10_000));
        }
        assert.ok(listed, `deployed agent ${agentName} not found in the runtime list`);
        return { durationMs: result.durationMs };
      });

      await stage('S5-invoke', async () => {
        // Runtime readiness after launch is asynchronous: the first invoke can
        // hit a not-yet-READY runtime ("could not get access_endpoint").
        // Each retry costs one approval token (single-use), so attempts are
        // counted separately and folded into the S6 metric.
        let attempt = 0;
        let out = '';
        for (; attempt < 3; attempt += 1) {
          const result = await approvedRun(['invoke', '{"message":"hello e2e"}', '--agent', agentName], {
            timeoutMs: 900_000,
          });
          out = String(result.stdout);
          if (result.ok && /Processed: hello e2e|hello e2e/.test(out)) break;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 20_000));
        }
        report.invokeAttempts = attempt + 1;
        assert.match(
          out,
          /Processed: hello e2e|hello e2e/,
          `basic template did not echo the payload: ${out.slice(0, 500)}`,
        );
        return { invokeAttempts: report.invokeAttempts, responseSnippet: out.slice(0, 200) };
      });

      await stage('S5-destroy', async () => {
        const result = await approvedRun(['destroy', '--yes'], { timeoutMs: 300_000 });
        assert.equal(result.ok, true, `destroy failed: ${(result.stderr || result.error || '').slice(0, 2000)}`);
        deployed = false;
        // Clean-teardown contract, closed from list output (not just exit
        // output): the runtime disappears from the list. Eventual
        // consistency gets a retry window; a destroy that reports success
        // while the runtime stays listed is the silent-failure class this
        // e2e exists to catch.
        let gone = false;
        let lastDetail = '';
        for (let attempt = 0; attempt < 3 && !gone; attempt += 1) {
          const check = await listAgentartsAgents({ agent_name: agentName });
          if (check.ok) {
            gone = !(check.agents || []).some((a) => a?.name === agentName);
            lastDetail = gone ? '' : 'still listed';
          } else {
            lastDetail = `list-agents failed: ${check.stderr || check.error}`;
          }
          if (!gone && attempt < 2) await new Promise((r) => setTimeout(r, 10_000));
        }
        assert.ok(gone, `agent ${agentName} not gone after destroy — ${lastDetail}`);
        return {};
      });

      // ---- S6: teardown, canary, report ------------------------------------
      await stage('S6-teardown-canary', async () => {
        const hits = canaryScan(artifacts, creds);
        const scratchHits = scanTree(scratch, creds);
        const tmpHits = scanTree(join('/tmp', 'huaweicloud-devkit'), creds);
        const leakPaths = [...scratchHits, ...tmpHits];
        assert.deepEqual(hits, [], 'credential literals leaked into captured outputs');
        assert.deepEqual(leakPaths, [], `credential literals leaked into files: ${leakPaths.join(', ')}`);

        // Approval-count metric: the golden path is exactly 4 approvals
        // (config, launch, invoke, destroy) — init/dev are local tier. Invoke
        // readiness retries add one approval each (single-use tokens).
        const expected = 3 + (report.invokeAttempts || 1);
        assert.equal(report.approvals, expected, `expected ${expected} approvals, counted ${report.approvals}`);
        return {};
      });
    } finally {
      // Convergence: a failure after deploy must not leave a billed agent.
      // Best-effort destroy via a direct spawn (the wrapper's approval flow
      // is the agent's channel; cleanup is the harness's own responsibility),
      // recorded in the report either way. The report is ALWAYS written.
      if (deployed && runAgentartsApprovedCommand && planAgentartsCommand) {
        try {
          const plan = planAgentartsCommand(['destroy', '--yes']);
          if (plan.approvalToken) {
            const result = await runAgentartsApprovedCommand({
              args: ['destroy', '--yes'],
              approvalToken: plan.approvalToken,
              approvedByUser: true,
              timeoutMs: 300_000,
              cwd: agentDir,
            });
            report.finallyDestroy = { ok: result.status === 'ok' && result.ok !== false, code: result.code || null };
            if (result.status === 'ok' && result.ok !== false) deployed = false;
          }
        } catch (error) {
          report.finallyDestroy = { ok: false, error: String(error.message || error) };
        }
      }
      report.residue = deployed;
      if (deployed) {
        report.residueNote = `agent ${agentName} may still be deployed — destroy it in your own terminal (agentarts destroy --yes) or via the console`;
      }
      const reportPath = writeReport();
      if (report.residue) {
        // Surface the residue loudly even though the stage assertions already
        // threw: the operator reading the failure output must see it.
        process.stderr.write(`E2E RESIDUE: ${report.residueNote} (report: ${reportPath})\n`);
      }
    }

    // Post-assertions that must NOT run inside the try (they inspect the
    // final report state and re-scan it after write).
    const reportPath = join(SCRATCH_ROOT, 'e2e', `report-${runid}.json`);
    const reportText = readFileSync(reportPath, 'utf8');
    assert.ok(
      !reportText.includes(creds.AK) && !reportText.includes(creds.SK),
      'credential literals leaked into the report',
    );
    assert.equal(statSync(reportPath).mode & 0o777, 0o600, 'report must be 0600');
  },
);

test('agentarts e2e gate contract (no cloud access)', () => {
  assert.equal(typeof GATE, 'boolean');
  if (!GATE) {
    assert.equal(existsSync(CREDS_PATH), existsSync(CREDS_PATH));
  }
});

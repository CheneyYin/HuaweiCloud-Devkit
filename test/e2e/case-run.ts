// The per-case orchestration: attempt loop with fresh throwaway home +
// workdir + fakes per attempt, install → run → collect → evaluate, and the
// harness-crash belt that turns a crash into a runner-error attempt.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCaseEnv, scrubSecrets } from './env-policy.ts';
import { evaluateCase, type CaseVerdict, type Recordings } from './evaluate.ts';
import { HttpFake } from './http-fake.ts';
import { WsFake } from './ws-fake/hwlink-server.ts';
import type { E2eCase } from './types.ts';
import type { AgentDriver } from './drivers/types.ts';
import { TEMP_PREFIX } from './harness.ts';
import { installPathShim, seamVars } from './seams.ts';
import { runInstall } from './pack-install.ts';
import { renderPrompt, seedHome, seedWorkdir } from './case-fixtures.ts';
import { collectFiles, emptyRecordings, readGatewayLog, readHcloudLog, readTrace } from './recordings.ts';
import {
  installCallSummary,
  runnerErrorVerdict,
  scrubbedStack,
  summarizeGatewayCalls,
  summarizeHcloudCalls,
  summarizeHttpCalls,
  summarizeWsCalls,
  type AttemptReport,
  type CaseRunReport,
} from './report.ts';

export async function runCase(
  caseDef: E2eCase,
  driver: AgentDriver,
  bin: string,
  kooCliVersion: string,
): Promise<{ verdict: CaseVerdict; recordings: Recordings; report: CaseRunReport }> {
  const attempts: AttemptReport[] = [];
  let lastVerdict: CaseVerdict | null = null;
  let lastRecordings: Recordings = emptyRecordings();
  const maxAttempts = Math.max(1, caseDef.budget.attempts);

  // Recorded skips resolve once, before any attempt spends budget: platform
  // exclusion, or a packs-posture channel the driver's install target does
  // not implement (the codex CLI owns that target's MCP config; a silently
  // unapplied posture would misattribute a toolsList mismatch).
  const skipReason =
    caseDef.unsupportedPlatforms?.find((p) => p.platform === process.platform)?.reason ??
    (caseDef.installPacks && !driver.supportsInstallPacks
      ? `installPacks rides the install --packs channel, which the ${driver.id} target does not implement`
      : undefined);
  if (skipReason) {
    return {
      verdict: {
        caseId: caseDef.id,
        pass: true,
        liveness: true,
        expectations: [],
        soft: [],
      },
      recordings: lastRecordings,
      report: { attempts: [], skipped: { reason: skipReason } } satisfies CaseRunReport,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const home = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}home-`));
    const workdir = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}work-`));
    const wsFake = caseDef.fixtures.ws ? new WsFake() : null;
    let httpFake: HttpFake | null = null;
    try {
      // Ws fake first: its ephemeral port resolves the literal {wsUrl}
      // token inside the http script (the hwlink GET-poll returns it as
      // connection_info.url) before the http fake is constructed —
      // JSON round-trip so the token resolves wherever it appears
      // (renderPrompt precedent: one token, no templating language).
      await wsFake?.start();
      const httpScript =
        wsFake && caseDef.fixtures.http
          ? (JSON.parse(JSON.stringify(caseDef.fixtures.http).replaceAll('{wsUrl}', wsFake.wsUrl)) as NonNullable<
              E2eCase['fixtures']['http']
            >)
          : (caseDef.fixtures.http ?? { responses: [] });
      httpFake = new HttpFake(httpScript);
      await httpFake.start();
      seedHome(home, caseDef.fixtures);
      seedWorkdir(workdir, caseDef.fixtures);
      const pathShimDir = installPathShim(home);
      const scriptPath = caseDef.fixtures.hcloud ? join(home, 'hcloud-script.json') : null;
      if (scriptPath) writeFileSync(scriptPath, JSON.stringify(caseDef.fixtures.hcloud), 'utf8');
      // Some agents refuse to resolve a home that does not exist yet, and
      // the install spawns their CLI — the pre-install hook runs before it
      // and may contribute install-env vars (the codex egress block, which
      // must cover the install-time catalog-sync spawns too).
      const installDriverVars = driver.prepareHome?.(home) ?? {};
      // Install first — driver.prepare() merges the model/provider config
      // into the config file the installer just wrote, so it must run after.
      const installEnv = buildCaseEnv({
        processEnv: process.env,
        home,
        driverVars: installDriverVars,
        seamVars: seamVars(
          home,
          scriptPath,
          kooCliVersion,
          httpFake,
          caseDef.fixtures,
          pathShimDir,
          'hcloud-fake-install.log',
        ),
      });
      runInstall(bin, home, workdir, installEnv, driver.installTarget, caseDef.installPacks);
      const env = buildCaseEnv({
        processEnv: process.env,
        home,
        driverVars: driver.prepare({ home, workdir, platform: process.platform }),
        seamVars: seamVars(home, scriptPath, kooCliVersion, httpFake, caseDef.fixtures, pathShimDir),
        caseEnv: caseDef.env,
        relaxFixed: caseDef.fixtures.updateCheck ? ['HUAWEICLOUD_DEVKIT_SKIP_UPDATE'] : undefined,
      });
      if (caseDef.fixtures.updateCheck) {
        // Run-env only (never the install env): the product's registry seam.
        // npm itself never reads this var — only the devkit does — so the
        // agent's own npm usage (if any) is unaffected.
        env.HUAWEICLOUD_NPM_REGISTRY = httpFake.baseUrl;
      }

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), caseDef.budget.timeoutMs);
      let run;
      try {
        run = await driver.runPrompt({
          prompt: renderPrompt(caseDef.prompt, workdir),
          cwd: workdir,
          env,
          timeoutMs: caseDef.budget.timeoutMs,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const recordings: Recordings = {
        hcloud: readHcloudLog(home),
        ...readTrace(home),
        http: [...httpFake.recordings],
        gateway: readGatewayLog(home),
        ws: wsFake
          ? wsFake.connections.map((conn) => ({
              ...conn,
              commands: conn.commands.map((cmd) => ({ ...cmd })),
            }))
          : [],
        files: collectFiles(caseDef, home),
        finalText: run.finalText,
        exitCode: run.exitCode,
      };
      const verdict = evaluateCase(caseDef, recordings);
      lastVerdict = verdict;
      lastRecordings = recordings;
      attempts.push({
        attempt,
        exitCode: run.exitCode,
        hcloudCalls: summarizeHcloudCalls(recordings.hcloud),
        installHcloudCalls: installCallSummary(home),
        httpCalls: summarizeHttpCalls(recordings.http),
        gatewayCalls: summarizeGatewayCalls(recordings.gateway),
        wsCalls: summarizeWsCalls(recordings.ws),
        // The recorded transcript can echo anything the agent printed; the
        // model keys ride the session env (both legs), so their values are
        // scrubbed before the report exists — the report is a CI artifact.
        stdout: scrubSecrets(run.stdout).slice(0, 8000),
        stderr: scrubSecrets(run.stderr).slice(0, 4000),
        verdict,
      });
      if (verdict.pass) break;
    } catch (error) {
      // A harness crash (install failure, driver throw, fs error) must not
      // eat the suite's only diagnostics: the partial recordings and the
      // stack ship as a runner-error attempt, and the next attempt still
      // runs (transient throws recover; deterministic ones fail fast in
      // main after three consecutive runner-error cases).
      const stack = scrubbedStack(error);
      const verdict = runnerErrorVerdict(caseDef.id, stack);
      attempts.push({
        attempt,
        exitCode: null,
        hcloudCalls: summarizeHcloudCalls(readHcloudLog(home)),
        installHcloudCalls: installCallSummary(home),
        httpCalls: httpFake ? summarizeHttpCalls(httpFake.recordings) : [],
        gatewayCalls: summarizeGatewayCalls(readGatewayLog(home)),
        wsCalls: summarizeWsCalls(wsFake?.connections ?? []),
        stdout: stack.slice(0, 8000),
        stderr: '',
        verdict,
      });
      lastVerdict = lastVerdict ?? verdict;
    } finally {
      await httpFake?.stop();
      await wsFake?.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  return {
    verdict: lastVerdict!,
    recordings: lastRecordings,
    report: { attempts } satisfies CaseRunReport,
  };
}

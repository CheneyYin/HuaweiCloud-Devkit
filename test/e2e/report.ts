// The run report: per-attempt shapes, the harness-crash verdict, report
// retention, and the per-attempt call-list summaries shared by runCase's
// success and crash paths.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { scrubSecrets } from './env-policy.ts';
import type { CaseVerdict, GatewayRecording } from './evaluate.ts';
import type { HttpRecording } from './http-fake.ts';
import type { WsConnectionRecording } from './ws-fake/hwlink-server.ts';
import { readHcloudLog } from './recordings.ts';

export interface AttemptReport {
  attempt: number;
  exitCode: number | null;
  hcloudCalls: string[];
  // Install-phase probes (separate log since the channel split): present
  // with an empty run log separates "install ran, agent dead" from
  // "install itself crashed" — the CI triage this field was born from.
  installHcloudCalls: string[];
  httpCalls: string[];
  gatewayCalls: string[];
  wsCalls: string[];
  stdout: string;
  stderr: string;
  verdict: CaseVerdict;
}

export interface CaseRunReport {
  attempts: AttemptReport[];
  skipped?: { reason: string };
}

// The verdict shape for a harness crash (constructed by the runner, never
// the evaluator): fail, not live, and the error's first line rides the
// verdict so the FAIL output distinguishes an infra crash from a dead
// agent — the two got conflated in the 2026-10-22 CI triage.
export function runnerErrorVerdict(caseId: string, stack: string): CaseVerdict {
  return {
    caseId,
    pass: false,
    liveness: false,
    expectations: [],
    soft: [],
    runnerError: stack.split('\n')[0]?.slice(0, 300) ?? 'unknown error',
  };
}

export function scrubbedStack(err: unknown): string {
  return scrubSecrets(String((err as Error)?.stack ?? err));
}

// Per-attempt call-list summaries — one copy each, used by both the success
// and the harness-crash attempt construction in case-run.ts.
export function summarizeHcloudCalls(calls: { argv: string[] }[]): string[] {
  return calls.map((c) => scrubSecrets(c.argv.join(' ')));
}

export function installCallSummary(home: string): string[] {
  return readHcloudLog(home, 'hcloud-fake-install.log').map((c) => c.argv.join(' '));
}

export function summarizeHttpCalls(recordings: HttpRecording[]): string[] {
  return recordings.map((h) => `${h.method} ${h.path}`);
}

export function summarizeGatewayCalls(recordings: GatewayRecording[]): string[] {
  return recordings.map((g) => `${g.method}${g.tool ? `:${g.tool}` : ''}`);
}

export function summarizeWsCalls(connections: WsConnectionRecording[]): string[] {
  return connections.map(
    (conn) =>
      `conn(source=${conn.source ?? 'n/a'}): ${conn.commands.map((c) => c.intent).join(',') || '(no commands)'}`,
  );
}

// Report retention: every run writes one JSON; without a prune the local
// .e2e-results/ dir grows without bound (D1). Keep the newest 20.
const REPORT_RETENTION = 20;

export function pruneReports(reportDir: string): void {
  try {
    const reports = readdirSync(reportDir)
      .filter((name) => name.startsWith('report-') && name.endsWith('.json'))
      .map((name) => ({ name, mtime: statSync(join(reportDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of reports.slice(REPORT_RETENTION)) {
      try {
        rmSync(join(reportDir, stale.name), { force: true });
      } catch {
        // best-effort: pruning must never fail a run
      }
    }
  } catch {
    // best-effort: pruning must never fail a run
  }
}

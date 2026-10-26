import type { AgentSaysMatcher, E2eCase, Expectation } from './types.ts';
import type { HttpRecording } from './http-fake.ts';
import type { WsConnectionRecording } from './ws-fake/hwlink-server.ts';
import { matchAgentSays } from './evaluate-matchers.ts';
import { expectationVerdict } from './evaluate-kinds.ts';

// Pure evaluation over collected recordings. Verdicts gate only on
// devkit-observable outbound artifacts (fake-boundary recordings, the
// env-gated trace, files); agent text is a soft signal. This module is the
// evaluator's stable face: the recording/verdict types and evaluateCase
// live here, the matcher layer in evaluate-matchers.ts / evaluate-sequence.ts,
// and the per-kind verdict constructors in evaluate-kinds.ts.

export interface HcloudCall {
  argv: string[];
}

export interface TraceToolCall {
  name: string;
  args: unknown;
  ok: boolean;
}

export interface TraceDisclosure {
  event: 'toolsList' | 'toolsListChanged' | 'instructions';
  toolCount?: number;
}

export interface GatewayRecording {
  method: string;
  tool: string | null;
  args: unknown;
}

export interface Recordings {
  hcloud: HcloudCall[];
  toolCalls: TraceToolCall[];
  disclosures: TraceDisclosure[];
  http: HttpRecording[];
  gateway: GatewayRecording[];
  ws: WsConnectionRecording[];
  files: Record<string, string | null>;
  finalText: string | null;
  // The agent process's exit code (null on timeout-kill signal death).
  // Boundary-liveness ignores it; disclosure-liveness requires 0 — the
  // honest cross-leg model-turn proof (a dead model wire exits non-zero
  // or null on both drivers, while codex's -o finalText can exist for a
  // turn that never completed).
  exitCode: number | null;
}

export interface ExpectationVerdict {
  expectation: Expectation;
  pass: boolean;
  evidence: string;
}

export interface CaseVerdict {
  caseId: string;
  pass: boolean;
  liveness: boolean;
  expectations: ExpectationVerdict[];
  soft: ExpectationVerdict[];
  // Set by the runner (never the evaluator) when an attempt crashed in
  // harness code instead of running the agent: the FAIL line prints this
  // instead of the liveness text, so an infra crash never reads as a dead
  // agent.
  runnerError?: string;
}

export function evaluateCase(caseDef: E2eCase, recordings: Recordings): CaseVerdict {
  const expectations: ExpectationVerdict[] = caseDef.expect.map((exp) => expectationVerdict(exp, recordings));

  const soft = (caseDef.softExpect ?? []).map((exp) => {
    const says = exp as { kind: 'agentSays'; text: AgentSaysMatcher };
    return {
      expectation: exp,
      pass: matchAgentSays(says.text, recordings.finalText),
      evidence: 'soft: recorded, not gating',
    };
  });

  // Liveness: any boundary-channel activity proves the agent→MCP→devkit chain
  // is alive, so a passing negative (noToolCall / max=0) cannot be the
  // vacuous green of a dead harness. Files are excluded on purpose: fixtures
  // can seed them. A session with zero tool calls, zero hcloud calls, zero
  // http requests, and zero gateway requests never exercised devkit at all.
  // The 'disclosure' mode (cases whose expected outcome IS zero boundary
  // activity, e.g. the vendor-ambiguity guard) uses two conjoined proofs:
  // an initialize-handshake disclosure (toolsList / instructions, recorded
  // at the transport's outbound wire face — never toolsListChanged, which
  // is not a handshake event) AND a zero agent exit code. The conjunction
  // closes the half-dead chain (server boots and handshakes BEFORE any
  // model turn, so disclosures alone prove the harness booted, not that
  // the model ever turned — a dead model wire would vacuously pass the
  // zero-activity expectations and reset the runner's dead-agent streak;
  // exitCode is the honest cross-leg model-turn proof because codex's -o
  // finalText can exist for a turn that never completed). A never-booted
  // chain fails on disclosures; a half-dead chain fails on exitCode; a
  // correctly-asking session passes with its own alibi, so the runner's
  // streak treats the pass exactly like a boundary-liveness pass. The
  // exit-code conjunct presumes both agent CLIs exit non-zero (or die to
  // null) on a dead model wire — an assumption, not a measurement; see
  // docs/e2e-testing-design.md's disclosure-liveness bullet for the
  // residual.
  const handshakeDisclosures = recordings.disclosures.filter(
    (d) => d.event === 'toolsList' || d.event === 'instructions',
  );
  const liveness =
    caseDef.liveness === 'disclosure'
      ? handshakeDisclosures.length > 0 && recordings.exitCode === 0
      : recordings.toolCalls.length > 0 ||
        recordings.hcloud.length > 0 ||
        recordings.http.length > 0 ||
        recordings.gateway.length > 0 ||
        recordings.ws.some((conn) => conn.commands.length > 0);

  return {
    caseId: caseDef.id,
    pass: liveness && expectations.every((v) => v.pass),
    liveness,
    expectations,
    soft,
  };
}

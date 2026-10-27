// The selfcheck's assertion ladder: one pure pass over the collected wire
// responses, hcloud log, trace, HTTP recordings, and ws commands. Every leg
// prints its FAIL detail (or its ok line) and folds into one boolean.
import type { TraceDisclosure, TraceToolCall } from './evaluate.ts';
import type { HttpRecording } from './http-fake.ts';
import { out } from './harness.ts';

interface SelfcheckEvidence {
  responses: Map<number, unknown>;
  hcloudCalls: string[];
  toolCalls: TraceToolCall[];
  disclosures: TraceDisclosure[];
  httpRecordings: HttpRecording[];
  wsCommands: string[];
}

function toolPayload(responses: Map<number, unknown>, id: number): Record<string, unknown> | null {
  const resp = responses.get(id) as { result?: { content?: { type: string; text?: string }[] } } | undefined;
  const text = resp?.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function verifySelfcheckLegs(evidence: SelfcheckEvidence): boolean {
  const { responses } = evidence;
  const calls = evidence.hcloudCalls;
  const trace = { toolCalls: evidence.toolCalls, disclosures: evidence.disclosures };
  let ok = true;
  const listResponse = responses.get(2) as { result?: { tools?: { name?: unknown }[] } } | undefined;
  const toolCount = listResponse?.result?.tools?.length ?? 0;
  if (toolCount < 40) {
    out(`[selfcheck] FAIL tools/list returned only ${toolCount} tools`);
    ok = false;
  } else {
    out(`[selfcheck] tools/list: ${toolCount} tools`);
  }
  // The challenge bounce on the wire: the first asserted gated call is
  // a proper tool result (never a protocol error) carrying the
  // BY-THE-USER-or-assumed challenge text.
  const bounce = responses.get(3) as { result?: { isError?: boolean; content?: { text?: string }[] } } | undefined;
  const bounceText = bounce?.result?.content?.find((c) => 'text' in c)?.text ?? '';
  if (
    bounce?.result?.isError !== true ||
    !/Vendor challenge: first Huawei Cloud tool call this session/.test(bounceText)
  ) {
    out(
      `[selfcheck] FAIL the first asserted call did not bounce with the vendor challenge: ${JSON.stringify(bounce).slice(0, 200)}`,
    );
    ok = false;
  } else {
    out('[selfcheck] the first asserted gated call bounced with the vendor challenge (wire-pinned)');
  }
  const check = toolPayload(responses, 9);
  if (!check || check.installed !== true) {
    out(
      `[selfcheck] FAIL the retried check_cli did not report the fake hcloud as installed: ${JSON.stringify(check).slice(0, 200)}`,
    );
    ok = false;
  } else {
    out(`[selfcheck] the retried check_cli sees the fake hcloud (version ${String(check.installedVersion)})`);
  }
  const plan = toolPayload(responses, 4);
  if (!plan || !('approvalToken' in plan)) {
    out(`[selfcheck] FAIL plan_cli_command returned no approvalToken: ${JSON.stringify(plan).slice(0, 200)}`);
    ok = false;
  } else {
    out('[selfcheck] plan_cli_command minted an approval token');
  }
  if (!calls.some((c) => c === 'version')) {
    out(`[selfcheck] FAIL fake hcloud log has no version probe: ${calls.join(' | ') || '(empty)'}`);
    ok = false;
  } else {
    out(`[selfcheck] fake hcloud recorded: ${calls.join(' | ')}`);
  }
  const tracedNames = trace.toolCalls.map((c) => `${c.name}(ok=${c.ok})`);
  if (!trace.toolCalls.some((c) => c.name === 'huaweicloud_check_cli' && c.ok)) {
    out(`[selfcheck] FAIL trace has no successful check_cli toolCall: ${tracedNames.join(' | ') || '(none)'}`);
    ok = false;
  } else {
    out(`[selfcheck] trace toolCalls: ${tracedNames.join(' | ')}`);
  }
  const toolsListEvents = trace.disclosures.filter((d) => d.event === 'toolsList');
  if (toolsListEvents.length === 0 || toolsListEvents[0]?.toolCount !== toolCount) {
    out(
      `[selfcheck] FAIL trace toolsList disclosure disagrees with the wire count: ${JSON.stringify(toolsListEvents)}`,
    );
    ok = false;
  } else {
    out(`[selfcheck] trace disclosure toolsList=${toolsListEvents[0]?.toolCount} (x${toolsListEvents.length})`);
  }
  // The HTTP fake leg: voucher_status over the seeded vault must answer
  // through the scripted local endpoint (the user-hash prewarm's 404 on
  // the same fake is expected boot noise, not a failure).
  const voucher = toolPayload(responses, 5);
  if (!voucher || voucher.claimed !== true) {
    out(`[selfcheck] FAIL voucher_status did not report claimed=true: ${JSON.stringify(voucher).slice(0, 200)}`);
    ok = false;
  } else {
    out('[selfcheck] voucher_status answered through the local HTTP fake');
  }
  const voucherHits = evidence.httpRecordings.filter((r) => r.method === 'GET' && r.path === '/voucher/status');
  if (voucherHits.length === 0) {
    out(
      `[selfcheck] FAIL HTTP fake has no GET /voucher/status recording: ${
        evidence.httpRecordings.map((r) => `${r.method} ${r.path}`).join(' | ') || '(empty)'
      }`,
    );
    ok = false;
  } else {
    out(`[selfcheck] HTTP fake recorded GET /voucher/status (x${voucherHits.length})`);
  }
  // The v2 tool × trace seam leg: list_skills through the live wire and
  // the callTool wrapper. No 28-case live run calls this tool, and the
  // unit suite only exercises it with tracing off — this is the one
  // gate that proves the newest core tool lands in the trace like every
  // other dispatch.
  const skills = toolPayload(responses, 7);
  if (!skills || skills.ok !== true || typeof skills.count !== 'number' || skills.count < 1) {
    out(`[selfcheck] FAIL list_skills returned no catalog: ${JSON.stringify(skills).slice(0, 200)}`);
    ok = false;
  } else if (typeof skills.skillRoot !== 'string') {
    out(`[selfcheck] FAIL list_skills withheld skillRoot on a stdio session: ${JSON.stringify(skills).slice(0, 200)}`);
    ok = false;
  } else {
    out(`[selfcheck] list_skills returned ${skills.count} entries with skillRoot`);
  }
  if (!trace.toolCalls.some((c) => c.name === 'huaweicloud_list_skills' && c.ok)) {
    out(`[selfcheck] FAIL trace has no list_skills toolCall: ${tracedNames.join(' | ') || '(none)'}`);
    ok = false;
  } else {
    out('[selfcheck] list_skills traced through the callTool wrapper');
  }
  // The ws-exec leg: sandbox connect + a >8172-byte one-shot exec through
  // the PRODUCT's own client stack (session-manager → hwlink API → ws
  // multiplexer → fake) — subprotocol echo, nonce handshake, chunk
  // reassembly, and marker completion all in one LLM-less proof.
  const exec = toolPayload(responses, 8);
  const execStdout = typeof exec?.stdout === 'string' ? exec.stdout : '';
  if (!execStdout.includes('A'.repeat(1000))) {
    out(
      `[selfcheck] FAIL exec_one_shot did not return the reassembled echo output (got ${execStdout.length} chars): ${JSON.stringify(exec).slice(0, 200)}`,
    );
    ok = false;
  } else {
    out(`[selfcheck] exec_one_shot returned ${execStdout.length} chars of reassembled output`);
  }
  if (!evidence.wsCommands.includes('echo')) {
    out(`[selfcheck] FAIL ws fake recorded no echo intent: ${evidence.wsCommands.join(' | ') || '(none)'}`);
    ok = false;
  } else {
    out(`[selfcheck] ws fake recorded: ${evidence.wsCommands.join(' | ')}`);
  }
  if (evidence.wsCommands.includes('unknown')) {
    out(`[selfcheck] FAIL ws fake recorded unknown intents — script drift: ${evidence.wsCommands.join(' | ')}`);
    ok = false;
  }
  return ok;
}

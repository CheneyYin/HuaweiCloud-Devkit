// The fake shell: recognizes the product client's own command vocabulary
// and answers it. The marker formats (nonce framing) come from the
// PRODUCT's buildMarkers — single source of truth, cross-tier pinned by
// test/ws-exec-protocol.test.ts (feed buildShellCommands output through
// these recognizers; drift on either side reds the test).
import { buildMarkers } from '../../../plugins/huaweicloud-core/src/ws-exec/ws-exec-client.ts';

const MARKERS = buildMarkers('0000000000000000');

// The product's own marker prefixes (single source of truth — the golden
// test pins both sides together).
export const READY_PREFIX = MARKERS.readyPrefix;
export const DONE_PREFIX = MARKERS.donePrefix;

export interface ShellResult {
  intent: string;
  stdout: string;
  exitCode: number;
}

// Recognized-intent table — data, not branches. An unrecognized first line
// records intent 'unknown' (generic exit 0): the ws expectation channel
// gates zero-unknown, so a product script edit the fake no longer
// recognizes turns cases red instead of silently degrading.
interface IntentRow {
  intent: string;
  pattern: RegExp;
  run: (firstLine: string) => { stdout: string };
}

const INTENT_TABLE: IntentRow[] = [
  {
    intent: 'echo',
    pattern: /^echo\s+/,
    run: (line) => ({ stdout: `${line.replace(/^echo\s+/, '')}\n` }),
  },
  {
    // handleConnect's best-effort cleanup (session-manager.ts).
    intent: 'devbridge-delete-all',
    pattern: /^devbridge\s+delete-all\b/,
    run: () => ({ stdout: '' }),
  },
  {
    // handleConnect's PATH export for later devbridge calls.
    intent: 'export-path',
    pattern: /^export\s+PATH=/,
    run: () => ({ stdout: '' }),
  },
];

export function runShellCommand(blob: string): ShellResult {
  const firstLine = blob.split('\n', 1)[0] ?? '';
  for (const row of INTENT_TABLE) {
    if (row.pattern.test(firstLine)) {
      return { intent: row.intent, exitCode: 0, ...row.run(firstLine) };
    }
  }
  return { intent: 'unknown', stdout: '', exitCode: 0 };
}

// --- nonce recognition (product vocabulary, exported for the golden pins) ---

// The client's ready command embeds the nonce as the printf argument
// `'__WS_EXEC_READY_' '<nonce>__'`.
export function extractReadyNonce(readyCommand: string): string | null {
  const re = new RegExp(`${MARKERS.readyPrefix}'\\s+'([0-9a-f]+)__'`);
  const hit = re.exec(readyCommand);
  return hit ? hit[1]! : null;
}

// The client's done command embeds it as `'__WS_EXEC_DONE_' '<nonce>__:'`.
export function extractDoneNonce(doneLine: string): string | null {
  const re = new RegExp(`${MARKERS.donePrefix}'\\s+'([0-9a-f]+)__:`);
  const hit = re.exec(doneLine);
  return hit ? hit[1]! : null;
}

// A line is the done-terminator when it starts with the client's rc probe.
export function isDoneCommandLine(line: string): boolean {
  return line.startsWith('__ws_exec_rc=$?');
}

export function readyMarkerFor(nonce: string): string {
  return `\n${MARKERS.readyPrefix}${nonce}__\n`;
}

export function doneMarkerFor(nonce: string, exitCode: number): string {
  return `\n${MARKERS.donePrefix}${nonce}__:${exitCode}\n`;
}

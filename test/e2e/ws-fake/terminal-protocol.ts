// The terminal-session half of the hwlink fake: per-connection byte-stream
// reassembly (the client chunks sends at MAX_SEND_CHUNK_SIZE -
// FIXED_HEADER_LEN = 8172 bytes; a 60KB upload line arrives as ~8 ws
// messages), the ready handshake (the client's own nonce echoed back), and
// command-blob dispatch on the done-marker terminator — using the product's
// marker vocabulary (fake-shell.ts).
import {
  FIXED_HEADER_LEN,
  MAX_SEND_CHUNK_SIZE,
  OpCode,
  createPacket,
} from '../../../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import {
  READY_PREFIX,
  doneMarkerFor,
  extractDoneNonce,
  extractReadyNonce,
  isDoneCommandLine,
  readyMarkerFor,
  runShellCommand,
  type FakeFs,
} from './fake-shell.ts';
import type { ConnState } from './hwlink-server.ts';

const SEND_CHUNK = MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN;

function sendTerminalData(state: ConnState, text: string): void {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK) {
    const chunk = bytes.subarray(offset, Math.min(offset + SEND_CHUNK, bytes.length));
    const frame = createPacket({
      operation: OpCode.OpCmdTerminalData,
      identifier: state.identifier ?? 0,
      source: state.recording.source ?? 0,
      payload: chunk,
    });
    state.socket.send(Buffer.from(frame));
  }
}

export function drainTerminalBuffer(state: ConnState, fs: FakeFs): void {
  // 1. Ready handshake: the client sends its ready command and waits for
  //    its own nonce echoed back (a fake-emitted nonce never completes it).
  if (!state.readyNonce) {
    const idx = state.input.indexOf(READY_PREFIX);
    if (idx === -1) return;
    const lineEnd = state.input.indexOf('\n', idx);
    if (lineEnd === -1) return; // partial line: wait for more bytes
    const nonce = extractReadyNonce(state.input.slice(0, lineEnd));
    if (!nonce) return;
    state.readyNonce = nonce;
    state.input = state.input.slice(lineEnd + 1);
    sendTerminalData(state, readyMarkerFor(nonce));
  }
  // 2. Command blobs, each terminated by the done line.
  while (state.readyNonce) {
    const doneIdx = state.input.indexOf('__ws_exec_rc=$?');
    if (doneIdx === -1) return;
    const lineEnd = state.input.indexOf('\n', doneIdx);
    if (lineEnd === -1) return; // partial done line: wait
    const blob = state.input.slice(0, doneIdx);
    const doneLine = state.input.slice(doneIdx, lineEnd);
    state.input = state.input.slice(lineEnd + 1);
    if (!isDoneCommandLine(doneLine)) continue;
    const nonce = extractDoneNonce(doneLine) ?? state.readyNonce;
    const result = runShellCommand(blob, fs);
    state.recording.commands.push({ intent: result.intent, exitCode: result.exitCode });
    sendTerminalData(state, result.stdout + doneMarkerFor(nonce, result.exitCode));
  }
}

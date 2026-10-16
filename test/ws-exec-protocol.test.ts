import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIXED_HEADER_LEN,
  MAX_SEND_CHUNK_SIZE,
  OpCode,
  createPacket,
  parsePacket,
} from '../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import { buildMarkers, buildShellCommands } from '../plugins/huaweicloud-core/src/ws-exec/ws-exec-client.ts';
import {
  doneMarkerFor,
  extractDoneNonce,
  extractReadyNonce,
  readyMarkerFor,
  runShellCommand,
} from './e2e/ws-fake/fake-shell.ts';

// Golden pins for the hwlink wire protocol the E2E ws-fake shares with the
// product. The fake imports the product's codec, so a codec regression
// makes fake and product regress TOGETHER — these literal byte vectors are
// the independent oracle that catches the drift (vendored upstream hwlink
// format: 20-byte big-endian header, one packet per ws message).

test('createPacket golden bytes: terminal open (0xfb, username payload)', () => {
  const frame = createPacket({
    operation: OpCode.OpNewCmdTerminal,
    identifier: 5,
    source: 12345,
    payload: new TextEncoder().encode('root'),
  });
  assert.equal(
    Buffer.from(frame).toString('hex'),
    '05000018000000fb000000000000000500003039' + '726f6f74',
    'terminal-open frame must match the upstream hwlink layout byte-for-byte',
  );
});

test('createPacket golden bytes: terminal data (0xfd, small payload)', () => {
  const frame = createPacket({
    operation: OpCode.OpCmdTerminalData,
    identifier: 5,
    source: 12345,
    payload: new TextEncoder().encode('hi'),
  });
  assert.equal(Buffer.from(frame).toString('hex'), '05000016000000fd000000000000000500003039' + '6869');
});

test('parsePacket round-trips the golden terminal-open bytes', () => {
  const bytes = Buffer.from('05000018000000fb000000000000000500003039' + '726f6f74', 'hex');
  const packet = parsePacket(bytes);
  assert.equal(packet.operation, 0xfb);
  assert.equal(packet.identifier, 5);
  assert.equal(packet.source, 12345);
  assert.equal(Buffer.from(packet.data ?? []).toString('utf8'), 'root');
  assert.equal(packet.packetLength, bytes.length);
});

test('chunk math both sides rely on: MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN === 8172', () => {
  assert.equal(MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN, 8172);
  assert.equal(FIXED_HEADER_LEN, 20);
});

// Cross-tier marker pins: the fake's recognizers must recover exactly what
// the product's buildShellCommands emits — drift on EITHER side reds here.

test('fake recognizers recover the product-built ready/done nonces', () => {
  const markers = buildMarkers('aabbccddeeff0011');
  const { readyCommand, doneCommand } = buildShellCommands(markers);
  assert.equal(extractReadyNonce(readyCommand), 'aabbccddeeff0011');
  assert.equal(extractDoneNonce(doneCommand), 'aabbccddeeff0011');
  // The emitted markers must be the exact strings the product's
  // tryCompletePending scans for (ready echo / done + ':<rc>').
  assert.ok(readyMarkerFor('aabbccddeeff0011').includes('__WS_EXEC_READY_aabbccddeeff0011__'));
  assert.ok(doneMarkerFor('aabbccddeeff0011', 0).includes('__WS_EXEC_DONE_aabbccddeeff0011__:0'));
});

test('buildShellCommands output shape is pinned (printf framing)', () => {
  const { readyCommand, doneCommand } = buildShellCommands(buildMarkers('deadbeefdeadbeef'));
  assert.match(readyCommand, /stty -echo 2>\/dev\/null/);
  assert.match(readyCommand, /__WS_EXEC_READY_' 'deadbeefdeadbeef__'/);
  assert.match(doneCommand, /^__ws_exec_rc=\$\?; printf /);
  assert.match(doneCommand, /__WS_EXEC_DONE_' 'deadbeefdeadbeef__:/);
});

test('fake shell intent table: echo answers its text, probes answer empty, unknown is distinct', () => {
  const echo = runShellCommand('echo hello-from-e2e\n');
  assert.equal(echo.intent, 'echo');
  assert.equal(echo.stdout, 'hello-from-e2e\n');
  assert.equal(echo.exitCode, 0);

  assert.equal(runShellCommand('devbridge delete-all 2>/dev/null || true\n').intent, 'devbridge-delete-all');
  assert.equal(runShellCommand('export PATH=$HOME/.huawei/bin${PATH:+:$PATH}\n').intent, 'export-path');
  // Unrecognized commands record distinctly — the zero-unknown gate keys on
  // this so product script drift turns cases red instead of degrading.
  assert.equal(runShellCommand('some-future-script --flag\n').intent, 'unknown');
});

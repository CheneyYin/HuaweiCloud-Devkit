// Structure guards for the ws-exec hwlink family split (REPORT-hwlink.md):
// hwlink-exec-client.ts is the stable public face — a pure re-export — while
// the internals live in the src/ws-exec hwlink siblings (the safety-policy.ts
// precedent). These guards pin the face ownership and the family layering so
// a future extraction cannot drift them without rewriting this file: the
// normalizers stay pure leaves, the pending-exec correlation owns the
// request/response bookkeeping, the exec session owns the class and the
// entry points, and the interactive terminal owns the one-shot factory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { readSource, root } from './structure-helpers.ts';

const FACE = 'src/ws-exec/hwlink-exec-client.ts';
const NORMALIZE = 'src/ws-exec/hwlink-normalize.ts';
const INTERACTIVE = 'src/ws-exec/hwlink-interactive-terminal.ts';
const PENDING = 'src/ws-exec/hwlink-exec-pending.ts';
const SESSION = 'src/ws-exec/hwlink-exec-session.ts';
const FAMILY = [FACE, NORMALIZE, INTERACTIVE, PENDING, SESSION] as const;

test('hwlink-exec-client face is the pure re-export of the public surface', () => {
  const face = readSource(FACE);
  // The barrel (src/ws-exec/index.ts) re-exports this module with `export *`
  // and spreads its namespace; test/session-manager.test.ts imports the
  // resolved barrel and asserts connectHwlinkTerminalSession and
  // executeHwlinkCommand are functions. The face must keep re-exporting the
  // exact pre-split public set — six names, nothing added, nothing lost.
  assert.match(
    face,
    /export \{ connectHwlinkInteractiveTerminal, createHwlinkTerminal \} from '\.\/hwlink-interactive-terminal\.ts';/,
  );
  assert.match(
    face,
    /export \{\n {2}HwlinkTerminalExecSession,\n {2}connectHwlinkTerminalSession,\n {2}executeHwlinkCommand,\n\} from '\.\/hwlink-exec-session\.ts';/,
  );
  assert.match(face, /export \{ normalizeSource \} from '\.\/hwlink-normalize\.ts';/);
  // The face owns no implementation: no class, no factory, no normalizer.
  assert.doesNotMatch(face, /class HwlinkTerminalExecSession/);
  assert.doesNotMatch(face, /function createHwlinkTerminal\(/);
  assert.doesNotMatch(face, /function normalize(Source|Url|Command|Timeout)\(/);
});

test('the normalize sibling owns the shared input shaping and stays a leaf', () => {
  const normalize = readSource(NORMALIZE);
  for (const name of [
    'errorMessage',
    'isFiniteNumber',
    'normalizeCommand',
    'normalizeTimeout',
    'normalizeSource',
    'normalizeUrl',
  ]) {
    assert.match(
      normalize,
      new RegExp(`export function ${name}\\(`),
      `${name} must stay owned by the normalize sibling`,
    );
  }
  // Layering: the normalizers import no family module, so the family stays
  // acyclic (normalize a leaf, pending above it, session/interactive on
  // top). Code-shaped check: prose mentions of sibling filenames in
  // doctrine comments are fine, import statements are not.
  assert.ok(!/^import .+hwlink-/m.test(normalize), 'normalize must not import a hwlink family sibling');
});

test('the pending sibling owns the exec request/response correlation', () => {
  const pending = readSource(PENDING);
  // The correlation bookkeeping: the PendingExec record, the result shape,
  // and the arm/complete/settle operations over the narrowed host shape.
  for (const decl of [
    'export interface HwlinkExecResult \\{',
    'export interface PendingExec \\{',
    'export interface PendingExecHost \\{',
    'export function armPendingExec\\(',
    'export function completePendingExec\\(',
    'export function settlePendingExec\\(',
  ]) {
    assert.match(pending, new RegExp(decl), `${decl} must stay owned by the pending sibling`);
  }
  // The correlation may not reach back into the session class (a class
  // reference would couple the leaf to its consumer).
  assert.doesNotMatch(pending, /HwlinkTerminalExecSession/);
});

test('the session sibling owns the class and the entry points; interactive owns the factory', () => {
  const session = readSource(SESSION);
  assert.match(session, /class HwlinkTerminalExecSession \{/);
  for (const name of ['connectHwlinkTerminalSession', 'executeHwlinkCommand']) {
    assert.match(session, new RegExp(`function ${name}\\(`), `${name} must stay owned by the session sibling`);
  }
  // The delegation seams: data-pump correlation and exec arming go through
  // the pending sibling; teardown settlement goes through settlePendingExec.
  assert.match(session, /completePendingExec\(this\);/);
  assert.match(session, /return armPendingExec\(this, shellCommand, timeoutMs,/);
  assert.match(session, /settlePendingExec\(/);

  const interactive = readSource(INTERACTIVE);
  for (const name of ['createHwlinkTerminal', 'connectHwlinkInteractiveTerminal']) {
    assert.match(interactive, new RegExp(`function ${name}\\(`), `${name} must stay owned by the interactive sibling`);
  }
  assert.match(interactive, /interface CreateHwlinkTerminalOptions \{/);
  assert.match(interactive, /interface HwlinkTerminalHandle \{/);
});

test('the family keeps bundle-graph discipline and NOTICE attribution', () => {
  // Bundle-graph discipline for every family member: no zod, no SDK, no
  // __dirname/import.meta.url path derivation (the esbuild depth trap —
  // the family feeds the bundled mcp-server graph through the ws-exec
  // barrel -> session-manager face -> sandbox pack).
  for (const name of FAMILY) {
    const src = readSource(name);
    assert.ok(!/^import .*'zod';/m.test(src), `${name} must not import zod`);
    assert.ok(!/__dirname|import\.meta\.url/.test(src), `${name} must not derive paths from its module URL`);
    assert.ok(!/^import .+@modelcontextprotocol/m.test(src), `${name} must not import the MCP SDK`);
  }
  // License attribution: every family member that carries hwlink-derived
  // code must stay listed in NOTICE (the face is the re-export seam and
  // carries none; the four siblings do).
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  for (const name of [NORMALIZE, INTERACTIVE, PENDING, SESSION]) {
    const compiled = name.replace(/^src\//, 'plugins/huaweicloud-core/src/').replace(/\.ts$/, '.js');
    assert.ok(notice.includes(compiled), `NOTICE must list the derived family member ${compiled}`);
  }
});

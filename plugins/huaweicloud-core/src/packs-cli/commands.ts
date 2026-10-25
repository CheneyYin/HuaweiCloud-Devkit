// The `packs` command family (post-install pack management), extracted from
// setup-cli.ts: status rendering and target selection. The set-math write
// modes (enable/disable/all) live in packs-cli/write-command.ts; the slot
// table in packs-cli/slots.ts.
//
// Install-time --packs never overwrites an existing DEVKIT_PACKS value (the
// keptUserValue contract, issue #615): a re-run with a different flag keeps
// what the operator typed. The `packs` commands are the one write path
// allowed to overwrite, because the command is the operator's explicit
// management action.

import { parseDevkitPacks } from '../lib/dependency-model.ts';
import { PACK_IDS } from '../lib/pack-types.ts';
import { SUPPORTED_AGENT_TARGETS } from '../auth/agent-registration.ts';
import { type CodexPluginProbe } from '../codex-probe.ts';
import { PACK_SLOTS, type PackSlot } from './slots.ts';
import { packUnionReport, renderCodexPacksLine, renderSecretsPackNote } from './report.ts';
import { cmdPacksWrite } from './write-command.ts';

export function printPacksUsage(): void {
  console.error(
    'Usage: npx huaweicloud-devkit packs <status | enable <id,...> | disable <id,...> | all> [--target <agent>|all]',
  );
  console.error(`Valid pack ids: ${PACK_IDS.join(', ')}`);
}

// Target selection for the packs commands. parseTarget's
// auto-detect-single-target semantics are wrong here: the useful default is
// every installed agent, not whichever one happens to be detected alone.
export function resolvePacksCommandTarget(): PackSlot[] | null {
  const idx = process.argv.indexOf('--target');
  if (idx < 0 || (process.argv[idx + 1] || '').toLowerCase() === 'all') {
    return PACK_SLOTS.filter((slot) => slot.installed());
  }
  const val = (process.argv[idx + 1] || '').toLowerCase();
  if (val === 'codex') {
    console.error('codex target is managed by codex CLI; set DEVKIT_PACKS in its MCP config manually');
    process.exitCode = 1;
    return null;
  }
  if (!SUPPORTED_AGENT_TARGETS.includes(val)) {
    console.error(`Unknown target: ${val}`);
    console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
    process.exitCode = 1;
    return null;
  }
  const slot = PACK_SLOTS.find((s) => s.id === val);
  if (!slot || !slot.installed()) {
    console.error(`${val} not installed — run install first`);
    process.exitCode = 1;
    return null;
  }
  return [slot];
}

// The unknown-id WARN in doctor's wording, shared by `packs status` and the
// enable/disable refusals: the server boot fail-fasts on unknown ids, and
// the fix hint is the `packs all` reset hatch.
export function warnPacksUnknownIds(slot: PackSlot, raw: string, unknown: readonly string[]): void {
  console.log(
    `  \x1b[33m[WARN]\x1b[0m Packs (${slot.label}): unknown id(s) in DEVKIT_PACKS="${raw}": ${unknown.join(', ')}`,
  );
  console.log(
    `        The MCP server will refuse to start until the value is fixed. Clear it: npx huaweicloud-devkit packs all --target <agent>`,
  );
}

export function cmdPacksStatus(): void {
  const slots = resolvePacksCommandTarget();
  if (!slots) return;
  if (slots.length === 0) {
    console.log('No installed targets found; run install first.');
    return;
  }
  for (const slot of slots) {
    const raw = slot.read() ?? '';
    if (raw.trim() === '') {
      console.log(`  \x1b[36m[INFO]\x1b[0m Packs (${slot.label}): all — DEVKIT_PACKS not set`);
      continue;
    }
    const parsed = parseDevkitPacks(raw);
    if (parsed.unknown.length > 0) {
      warnPacksUnknownIds(slot, raw, parsed.unknown);
      continue;
    }
    console.log(`  \x1b[36m[INFO]\x1b[0m Packs (${slot.label}): ${[...parsed.enabled].join(', ')}`);
  }
  // Discoverability note for pinned seeds missing the secrets pack — the
  // same packUnionReport() derivation doctor uses, so the two faces cannot
  // drift. One probe serves both the note and the codex attribution line
  // (report.codex carries the probe outcome; a second codexPluginProbe()
  // call would spawn the codex CLI twice per status run).
  const report = packUnionReport();
  renderSecretsPackNote(report, new Set(slots.map((slot) => slot.label)));
  renderCodexPacksLine(report.codex !== null, report.codex?.reason !== 'probe-failed');
}

// Write modes stay silent about codex by design (no write path there), but
// the silence needs one visible line when the plugin is installed or the
// probe fails, or the operator cannot tell the target was skipped.
export function renderCodexPacksWriteNote(probe: CodexPluginProbe): void {
  const contributes = probe.ok ? probe.installed : true;
  if (!contributes) return;
  console.log(
    `  \x1b[36m[INFO]\x1b[0m Packs (Codex CLI): codex target is managed by codex CLI; set DEVKIT_PACKS in its MCP config manually`,
  );
}

export function cmdPacks(): void {
  const sub = (process.argv[3] || '').toLowerCase();
  if (sub === 'status') {
    cmdPacksStatus();
    return;
  }
  if (sub === 'enable' || sub === 'disable' || sub === 'all') {
    cmdPacksWrite(sub);
    return;
  }
  printPacksUsage();
  process.exitCode = 1;
}

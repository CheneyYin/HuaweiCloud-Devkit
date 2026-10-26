import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { readNativeReceipt, writeNativeReceipt } from './lib/native-receipt.ts';
import { copyDir, removeIfExists } from './payload-files.ts';
import { coreSkillNames, devkitOwnedSkillNames } from './payload-roster.ts';
import { errorMessage, PLUGIN_ROOT } from './payload-utils.ts';

// The native-disclosure placement family (the install-payload.ts internals
// split): the PAYLOAD_TARGETS-shaped rows the seam consumes, the managed and
// scanned dir derivations, the per-target dispatch, and the per-dir
// remove-then-copy core-skill sync that converges one agent-native dir.

// The rows the table-consuming seam consumes: PAYLOAD_TARGETS' shape minus
// the fields the seam never reads.
export interface NativeSyncRow {
  id: string;
  nativeSkills?: () => string[];
}

// The dirs a PAYLOAD_TARGETS sync row owns — the managed set for receipt
// semantics (remembered names carry delete rights only here) and doctor's
// stale-scan exemption. Deliberately narrower than nativeSkillDirs():
// officeace's dir is scanned as a foreign surface, never managed.
export function nativeSyncDirs(rows: readonly NativeSyncRow[]): Set<string> {
  return new Set(rows.flatMap((t) => (t.nativeSkills ? t.nativeSkills() : [])));
}

// Agent-native skill directories: the surfaces agents load into their own
// system prompt. Derived from the rows' nativeSkills plus the caller's
// foreign scan dirs (officeace's dir is scanned only as a foreign surface —
// its registration face is capabilities.json, removed in 4a030c0 — never
// synced), so a future row cannot gain placement and miss the
// cleanup/doctor scan, the same single-table rule the payload checks follow.
// The codex-desktop plugin dir's skills/ is deliberately absent: that is
// server data, not a native dir.
export function nativeSkillDirs(rows: readonly NativeSyncRow[], foreignScanDirs: readonly string[]): string[] {
  return [...new Set([...rows.flatMap((t) => (t.nativeSkills ? t.nativeSkills() : [])), ...foreignScanDirs])];
}

// The native-disclosure seam: the install step table and the update
// dispatch both route through PAYLOAD_TARGETS, so a target that places
// payload refreshes its native core skills here — a target that does not
// never touches them, and a future row cannot appear in one path and miss
// the other.
export function syncNativeSkillsForTarget(rows: readonly NativeSyncRow[], target: string): void {
  const row = rows.find((t) => t.id === target);
  if (!row?.nativeSkills) return;
  for (const dir of row.nativeSkills()) syncNativeCoreSkills(dir);
}

// Place the core-pack skills into one agent-native dir and converge it:
// remove-then-copy per name (an overlay copy would keep files a newer tree
// retired), delete owned-but-not-core names and receipt names the current
// core set no longer claims, keep user skills, rewrite the receipt. Warn and
// continue on write failure — the native layer is disclosure, the MCP server
// remains the functional path, and doctor re-checks the result.
export function syncNativeCoreSkills(dir: string): void {
  const core = coreSkillNames();
  const owned = devkitOwnedSkillNames();
  const receipt = readNativeReceipt(dir);
  if (receipt?.kind === 'corrupt') {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m unreadable native receipt in ${dir} — this sync rewrites it; if it repeats, re-run install`,
    );
  }
  const remembered = receipt?.kind === 'ok' ? new Set(receipt.receipt.names) : new Set<string>();
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  // A manifest may claim core skills a partial tree does not ship; copyDir
  // would silently skip them while the receipt still claimed all names.
  // Place what exists, warn loudly about the rest, and record only what was
  // actually placed.
  const placeable = [...core].filter((name) => existsSync(join(skillsSrc, name)));
  const missing = [...core].filter((name) => !existsSync(join(skillsSrc, name)));
  if (missing.length > 0) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m core skill(s) claimed by the manifest but missing from the tree: ${missing.join(', ')} — from a git checkout run: npm run build`,
    );
  }
  if (placeable.length === 0) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m no core skills placeable into ${dir} — MCP disclosure remains authoritative; re-run install`,
    );
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of placeable) {
      rmSync(join(dir, name), { recursive: true, force: true });
      copyDir(join(skillsSrc, name), join(dir, name));
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const devkitClaimed = owned.has(entry.name) || remembered.has(entry.name);
      if (devkitClaimed && !core.has(entry.name)) {
        removeIfExists(join(dir, entry.name));
      }
    }
    writeNativeReceipt(dir, {
      names: [...placeable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      layout: 'plugin-dir',
    });
    console.log(`  Core skills (native disclosure) -> ${dir}`);
  } catch (error) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m native core skills not synced to ${dir}: ${errorMessage(error)} — ` +
        'MCP disclosure remains authoritative; re-run install',
    );
  }
}

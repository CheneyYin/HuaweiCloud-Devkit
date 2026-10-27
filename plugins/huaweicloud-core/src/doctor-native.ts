// The native-disclosure doctor checks, extracted from cmdDoctor: the
// stale-copy scan over every native dir (receipt-gated, officeace included
// as the foreign surface) and the per-row native-freshness loop (the honest
// comparator is the payload the target actually runs; the marketplace layout
// resolves its payload from the recorded package root). Byte-identical to
// the inline blocks they replace — the golden pin enforces it.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { DoctorReporter } from './doctor-report.ts';
import type { PayloadDoctorRow } from './doctor-payload.ts';
import { dshSkillsDir } from './targets.ts';
import { mcpServerInstalled, payloadCoreNames } from './install-payload.ts';
import { readNativeReceipt, marketplacePayloadTree } from './lib/native-receipt.ts';
import { skillTreeEquals } from './lib/skill-tree.ts';

// Native disclosure: the core meta-skills may sit natively only in a dir a
// PAYLOAD_TARGETS sync row manages (receipt present — a torn receipt file
// still proves placement); any other owned name — residue, a hand-placed
// copy, or a foreign dir like officeace's — warns, as do remembered names
// the core set no longer claims.
export function scanStaleNativeCopies(
  ctx: DoctorReporter,
  dirs: readonly string[],
  corePack: ReadonlySet<string>,
  owned: ReadonlySet<string>,
  syncDirs: ReadonlySet<string>,
): void {
  let staleNative = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const receipt = readNativeReceipt(dir);
    if (receipt?.kind === 'corrupt') {
      // For the DSH native dir the plain `install` remediation is the
      // layout-converting one (it would layer a plugin-dir install over a
      // possibly-live marketplace package): the profile's package install
      // rewrites the receipt too, so both remediations are named. Every
      // other dir was only ever written by this CLI.
      ctx.warn(
        `unreadable native receipt in ${dir} — ` +
          (dir === dshSkillsDir()
            ? "re-run the DSH profile's package install or npx huaweicloud-devkit install (either rewrites it)"
            : 're-run: npx huaweicloud-devkit install'),
      );
    }
    const remembered = receipt?.kind === 'ok' ? new Set(receipt.receipt.names) : new Set<string>();
    const managedHere = syncDirs.has(dir) && receipt !== null;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (owned.has(entry.name)) {
          if (managedHere && corePack.has(entry.name)) continue;
          staleNative++;
        } else if (managedHere && remembered.has(entry.name) && !corePack.has(entry.name)) {
          // A retired core skill living only in the receipt: cleanup deletes
          // it on the next install; doctor must see it too.
          staleNative++;
        }
      }
    } catch {
      // unreadable dir cannot confirm stale copies
    }
  }
  if (staleNative > 0) {
    ctx.warn(
      `${staleNative} stale native skill cop${staleNative === 1 ? 'y' : 'ies'} from an older or hand-made install — re-run: npx huaweicloud-devkit install`,
    );
  }
}

// Native freshness for one payload row: receipt-gated checks over each of
// the row's native dirs. Installed targets get freshness: the native copies
// must equal the payload the target actually runs.
export function nativeFreshnessChecks(
  ctx: DoctorReporter,
  row: PayloadDoctorRow,
  corePack: ReadonlySet<string> | null,
): void {
  if (!row.nativeSkills) return;
  for (const dir of row.nativeSkills()) {
    const receipt = readNativeReceipt(dir);
    // The marketplace layout (DSH npm-in-profile): the postinstall — the
    // only actor that runs in that layout — records it in the receipt
    // together with the package root it serves from. A detector built on
    // patch-file markers would not fire for real marketplace installs: the
    // bundled cordis.patch.yml DSH consumes never carries the CLI-managed
    // block's markers. The row guard matches the writer: only the dsh row's
    // dir can legitimately carry this layout, so a hand-copied receipt
    // elsewhere earns nothing.
    const packageRoot =
      receipt?.kind === 'ok' &&
      row.id === 'dsh' &&
      receipt.receipt.layout === 'package-root' &&
      typeof receipt.receipt.packageRoot === 'string'
        ? receipt.receipt.packageRoot
        : null;
    const installed = mcpServerInstalled(row.dir()) || packageRoot !== null;
    if (!existsSync(dir)) {
      // Absent without a receipt stays silent: the codearts project dir
      // only exists for the tree the install ran in.
      if (receipt !== null) {
        ctx.warn(
          `Native core skills (${row.label}): receipt present but the dir is gone — re-run: npx huaweicloud-devkit install --target ${row.id}`,
        );
      }
      continue;
    }
    if (!installed) {
      // A corrupt receipt erases the layout knowledge this branch needs:
      // the marketplace would be false-orphaned and the remediation would
      // layer a second install — the corrupt-receipt warning in the scan
      // above carries the remediation, so this branch speaks only for
      // readable receipts. The hedge fires when the receipt names a
      // maintainer this run cannot resolve: a layout-less receipt (written
      // before the layout field existed) or a marketplace receipt whose
      // root was dropped as malformed — less layout knowledge must never
      // earn a MORE confident prescription. The marketplace half of the
      // hedge is scoped to the dsh row: the postinstall only ever writes
      // ~/.dsh/skills, so for every other row a layout-less receipt can
      // only be a plugin-dir install and the precise remediation is
      // correct.
      if (receipt?.kind === 'ok' && row.id === 'dsh' && receipt.receipt.layout !== 'plugin-dir') {
        ctx.warn(
          `Native core skills (${row.label}) present without a plugin-dir MCP server and no resolvable layout — the marketplace install (DSH profile package) is also a possible owner; if it is stale, re-run the DSH profile's package install or npx huaweicloud-devkit install --target ${row.id}`,
        );
      } else if (receipt?.kind === 'ok') {
        ctx.warn(
          `Native core skills (${row.label}) present without an installed MCP server — re-run: npx huaweicloud-devkit install --target ${row.id}`,
        );
      }
      continue;
    }
    // The honest comparator is the payload the target actually runs — never
    // this CLI's tree, or `npx huaweicloud-devkit@latest doctor` would
    // false-report drift on an older healthy payload. The marketplace
    // layout resolves its payload from the recorded package root; the
    // plugin-dir layout reads the installed plugin dir. A remediation is
    // only honest if the command it names can run on that layout, so the
    // marketplace points at the package upgrade (update --target would
    // refuse: no plugin dir to update).
    let payloadTree: string | null;
    let fixHint: string;
    if (packageRoot !== null) {
      // packageRoot is control-character-stripped at READ time in the shared
      // receipt module (the single entry point for the untrusted field), so
      // every echo here is already forgery-safe.
      const shownRoot = packageRoot;
      const tree = marketplacePayloadTree(packageRoot);
      payloadTree = existsSync(tree) ? tree : null;
      fixHint = 'upgrade the huaweicloud-devkit package inside the DSH profile';
      if (payloadTree === null) {
        ctx.warn(
          `Native core skills (${row.label}): the recorded package root ${shownRoot} no longer carries a skills tree — reinstall the huaweicloud-devkit package in the DSH profile`,
        );
        continue;
      }
    } else if (existsSync(join(row.dir(), 'skills'))) {
      payloadTree = join(row.dir(), 'skills');
      fixHint = `re-run: npx huaweicloud-devkit update --target ${row.id}`;
    } else {
      // Installed (dist present) but no skills tree: the payload is broken.
      // The global skills-tree check is a some() across every candidate dir,
      // so a healthy target can mask this one — name it here instead of
      // silently skipping freshness.
      ctx.warn(
        `Native core skills (${row.label}): the installed payload has no skills tree — re-run: npx huaweicloud-devkit install --target ${row.id}`,
      );
      continue;
    }
    // The checked roster comes from the payload's own manifest, so a newer
    // doctor CLI never demands a core skill the installed payload never
    // shipped; only an unreadable payload manifest falls back to this CLI's
    // roster. The second fallback (empty) is unreachable — the shell runs
    // freshness only inside its non-null corePack guard — and keeps the
    // nullable shared-state type honest.
    const rosterCore = payloadCoreNames(payloadTree) ?? corePack;
    for (const name of rosterCore ?? []) {
      const nativeCopy = join(dir, name);
      if (!existsSync(nativeCopy)) {
        ctx.warn(`Native core skills (${row.label}): ${name} missing — ${fixHint}`);
        continue;
      }
      if (!skillTreeEquals(nativeCopy, join(payloadTree, name))) {
        ctx.warn(`Native core skills (${row.label}): ${name} diverges from the installed payload — ${fixHint}`);
      }
    }
  }
}

// The effective pack union and its renderers, extracted from setup-cli.ts:
// packUnionReport (the one derivation provisioning, `dep status`, doctor,
// and `dep uninstall` consume), the neutral unknown-id WARN, the secrets
// discoverability note, the codex attribution line, and install-time pack
// binary provisioning. The slot table lives in packs-cli/slots.ts; the
// doctor face in packs-cli/doctor.ts.

import { codexPluginProbe } from '../codex-probe.ts';
import { PACK_IDS, type PackId } from '../lib/pack-types.ts';
import { parseDevkitPacks, requiredDependencies } from '../lib/dependency-model.ts';
import { provisionDependencies } from '../dep/provision.ts';
import { custodyReport } from '../lib/secret-vault/custody.ts';
import { packStatusReaders } from './slots.ts';

// The effective pack union for provisioning, `dep status`, doctor's
// pack-dependency section, and the uninstall requirement check: every
// reader-backed installed target contributes its parsed closure
// (blank/unset config means the full surface), and codex contributes the
// full surface only when the devkit plugin is verifiably installed for codex
// (codexPluginProbe's `codex plugin list --json` signal) — the codex server
// boots with no DEVKIT_PACKS because the --packs flag has no write path
// there, so it always needs whatever the full surface needs, but a codex
// CLI that merely exists on PATH proves nothing about this devkit's
// footprint and must not widen the union (over-provisioned `--packs core`
// trims, phantom uninstall refusals). An UNREADABLE plugin list also widens
// the union (fail-safe, the same direction unknown DEVKIT_PACKS ids widen):
// a probe failure must never read as "not installed". Unknown ids in a
// target's DEVKIT_PACKS count as the full surface (fail-safe): skipping the
// target would under-provision its binaries. packUnionReport is the one
// derivation and is side-effect free — it returns per-target parse results
// and the per-target attribution `dep uninstall` names when it refuses, and
// each caller (provisioning, doctor, dep status, dep uninstall) renders its
// own flavor of warning.
export interface PackUnionTargetResult {
  label: string;
  /** The raw DEVKIT_PACKS value the target's config carried (null = absent). */
  raw: string | null;
  /** Closed under requires with core force-included; blank config means full surface. */
  enabled: ReadonlySet<PackId>;
  /** Ids not in PACK_IDS; non-empty means the target contributed the full surface. */
  unknown: readonly string[];
}

export interface PackUnionReport {
  union: ReadonlySet<PackId>;
  carriers: ReadonlyArray<{ label: string; packs: ReadonlySet<PackId> }>;
  /** Per-target parse results for callers that render (doctor, provisioning). */
  targets: ReadonlyArray<PackUnionTargetResult>;
  /** Why codex contributed to the union, when it did; null when it did not. */
  codex: { reason: 'plugin-installed' | 'probe-failed' } | null;
}

export function packUnionReport(): PackUnionReport {
  const union = new Set<PackId>();
  const carriers: Array<{ label: string; packs: ReadonlySet<PackId> }> = [];
  const targets: PackUnionTargetResult[] = [];
  for (const target of packStatusReaders()) {
    if (!target.installed) continue;
    const raw = target.read();
    const parsed = parseDevkitPacks(raw);
    targets.push({ label: target.label, raw, enabled: parsed.enabled, unknown: parsed.unknown });
    if (parsed.unknown.length > 0) {
      const full = new Set(PACK_IDS);
      for (const id of full) union.add(id);
      carriers.push({ label: target.label, packs: full });
      continue;
    }
    for (const id of parsed.enabled) union.add(id);
    carriers.push({ label: target.label, packs: parsed.enabled });
  }
  const codex = codexPluginProbe();
  // Polarity rule: a failed probe fails safe — it widens the union exactly
  // like an unknown DEVKIT_PACKS id and must never read as "not installed".
  const codexContributes = codex.ok ? codex.installed : true;
  if (codexContributes) {
    const full = new Set(PACK_IDS);
    for (const id of full) union.add(id);
    carriers.push({ label: 'Codex CLI', packs: full });
  }
  return {
    union,
    carriers,
    targets,
    codex: codexContributes ? { reason: codex.ok ? 'plugin-installed' : 'probe-failed' } : null,
  };
}

// The neutral unknown-id WARN the union consumers without their own flavor
// render (dep status, dep uninstall): a fail-safe widening must never be
// silent — a user whose DEVKIT_PACKS="bogus,core" shows 9 effective packs
// needs the line that explains why.
export function renderUnknownPackIds(report: PackUnionReport): void {
  for (const target of report.targets) {
    if (target.unknown.length === 0) continue;
    console.log(
      `  \x1b[33m[WARN]\x1b[0m Packs (${target.label}): unknown id(s) in DEVKIT_PACKS="${target.raw}": ${target.unknown.join(', ')} — treating the target as the full surface (fail-safe)`,
    );
  }
}

// The Codex CLI attribution line shared by doctor and `packs status`: codex
// has no DEVKIT_PACKS write path (the codex CLI owns its MCP config), so it
// always contributes the full surface when the plugin is verifiably
// installed or the probe fails (fail-safe polarity).
export function renderCodexPacksLine(contributes: boolean, probeOk: boolean): void {
  if (!contributes) return;
  const why = probeOk
    ? 'the devkit plugin is installed for codex'
    : 'codex plugin list could not be read, assuming the full surface (fail-safe)';
  console.log(`  \x1b[36m[INFO]\x1b[0m Packs (Codex CLI): all — ${why}`);
}

// The secrets-pack discoverability note, shared by doctor's pack block and
// `packs status`. Existing installs that pinned DEVKIT_PACKS before the
// secrets pack shipped keep their seed — the new pack is silently opt-in
// for them. Two shapes: a stored seed missing `secrets` gets a one-line
// INFO announcement (a new capability, not a fault); a seed missing
// `secrets` WHILE the vault is initialized is a real mismatch — the user
// stores secret:// refs but the MCP face is trimmed — and warns with the
// fix. Unset (full surface) or already-included seeds print nothing, and
// the vault probe never throws (a failing keychain tier reads as not
// initialized here — the dedicated vault block in doctor owns failure
// rendering).
export function renderSecretsPackNote(report: PackUnionReport, limitLabels?: ReadonlySet<string>): number {
  let vaultInitialized = false;
  try {
    vaultInitialized = custodyReport().initialized;
  } catch {
    // an unreadable custody tier is the vault block's story, not this note's
  }
  let warns = 0;
  for (const target of report.targets) {
    // `packs status --target X` narrows its slot loop; the note follows the
    // same filter so a filtered view does not advise on other agents' seeds.
    if (limitLabels && !limitLabels.has(target.label)) continue;
    if (target.raw === null || target.raw.trim() === '') continue;
    if (target.unknown.length > 0) continue;
    if (target.enabled.has('secrets')) continue;
    if (vaultInitialized) {
      warns++;
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Packs (${target.label}): the secret vault is initialized but the secrets pack is trimmed — the vault MCP tools (huaweicloud_secret_set/list/delete) are not disclosed on this target; secret:// refs still resolve wherever their consumers are enabled. Enable: npx huaweicloud-devkit packs enable secrets --target <agent>`,
      );
    } else {
      console.log(
        `  \x1b[36m[INFO]\x1b[0m Packs (${target.label}): new pack available — secrets (encrypted local vault, secret:// refs, npx huaweicloud-devkit secret set ...). Disclose it: npx huaweicloud-devkit packs enable secrets --target <agent>`,
      );
    }
  }
  return warns;
}

// Provision the enabled packs' host binaries right after payload placement.
// No output at all when nothing is required (empty union, e.g. a
// DEVKIT_PACKS=core-only install with no codex CLI).
export async function provisionPackBinaries(): Promise<void> {
  const report = packUnionReport();
  for (const target of report.targets) {
    if (target.unknown.length === 0) continue;
    console.log(
      `  \x1b[33m[WARN]\x1b[0m Packs (${target.label}): unknown id(s) in DEVKIT_PACKS="${target.raw}": ${target.unknown.join(', ')} — provisioning the full surface (fail-safe)`,
    );
  }
  const union = report.union;
  const deps = requiredDependencies(union);
  if (deps.size === 0) return;
  console.log(`\nProvisioning pack binaries (enabled packs: ${union.size})`);
  await provisionDependencies(deps, {
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
}

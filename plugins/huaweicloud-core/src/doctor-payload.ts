// The payload-triple doctor sections, one per PAYLOAD_TARGETS row: the
// server/undici/safety/skills-tree set-equality probes and the deferred
// native-freshness closure (the receipt-gated checks live in
// src/doctor-native.ts). setup-cli's table binds every row to a section
// factory — the generic payloadDoctorSection, or an agent-owned override
// (the dsh row's package-root candidate in agents/dsh-patch.ts) — so a new
// row cannot appear without its doctor coverage.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DoctorReporter } from './doctor-report.ts';
import { nativeFreshnessChecks } from './doctor-native.ts';
import { mcpServerInstalled, serverSkillDirNames } from './install-payload.ts';

// The structural slice of a PAYLOAD_TARGETS row the doctor sections consume.
export interface PayloadDoctorRow {
  id: string;
  label: string;
  dir(): string;
  nativeSkills?(): string[];
}

// Shared, side-effect-free doctor state computed once per run: the CLI-side
// expected skills roster, the core-pack roster (null = unusable manifest),
// the devkit-owned skill names, and the receipt-managed sync dirs.
export interface DoctorSharedState {
  expectedSkills: readonly string[];
  corePack: ReadonlySet<string> | null;
  owned: ReadonlySet<string>;
  syncDirs: ReadonlySet<string>;
}

// The payload triple: server present, runtime deps, safety policy, and the
// skills-tree set equality.
export interface PayloadTriple {
  server: boolean;
  undici: boolean;
  safety: boolean;
  skillsTree: boolean;
}

// One row's doctor section: the pure triple probes (run early — their
// results print in the shell's opening checks) and the deferred
// native-freshness checks (run late, after the stale-copy scan).
export interface PayloadDoctorSection {
  triple: PayloadTriple;
  nativeFreshness(ctx: DoctorReporter): void;
}

// What a PAYLOAD_TARGETS row binds as its doctor section.
export type PayloadDoctorBinding = (row: PayloadDoctorRow, shared: DoctorSharedState) => PayloadDoctorSection;

// Set equality against the shipped manifest, not a count floor and not a
// one-direction subset: verifySkillTree (boot) rejects missing, hollow (name
// present, SKILL.md absent), and unclaimed entries, so doctor must fail any
// payload the server would refuse to start — doctor's listing is the same
// shared predicate the boot guard uses.
export function skillsTreeMatches(dir: string, expectedSkills: readonly string[]): boolean {
  const present = new Set(serverSkillDirNames(dir));
  return present.size === expectedSkills.length && expectedSkills.every((name) => present.has(name));
}

// The generic per-row section: the triple over the row's plugin dir plus the
// receipt-gated native-freshness checks over the row's native dirs.
export function payloadDoctorSection(row: PayloadDoctorRow, shared: DoctorSharedState): PayloadDoctorSection {
  const dir = row.dir();
  return {
    triple: {
      server: mcpServerInstalled(dir),
      undici: existsSync(join(dir, 'node_modules', 'undici')),
      safety: existsSync(join(dir, 'safety', 'policy.json')),
      skillsTree: skillsTreeMatches(dir, shared.expectedSkills),
    },
    nativeFreshness: (ctx) => nativeFreshnessChecks(ctx, row, shared.corePack),
  };
}

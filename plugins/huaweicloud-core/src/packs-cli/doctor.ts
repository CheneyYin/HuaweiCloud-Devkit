// The doctor pack-status section, extracted from cmdDoctor: the per-target
// DEVKIT_PACKS lines, the codex attribution, the secrets discoverability
// note, and the pack-dependency availability block — all rendered from the
// SAME packUnionReport() derivation (packs-cli/report.ts) provisioning,
// `dep status`, and `dep uninstall` use.

import type { DoctorReporter } from '../doctor-report.ts';
import { DEPENDENCY_IDS, DEPENDENCIES, PACK_USES, requiredDependencies } from '../lib/dependency-model.ts';
import type { PackId } from '../lib/pack-types.ts';
import { resolveDependencyCommand } from '../lib/dep-resolve.ts';
import { renderCodexPacksLine, renderSecretsPackNote, type PackUnionReport } from './report.ts';

// Doctor's pack face. DEVKIT_PACKS is read from each installed target's MCP
// config file, not the process env: the value reaches the server process
// only after the agent harness injects the config env. Unknown ids warn
// because the server boot fail-fasts on them (src/packs/enable.ts).
// The per-target lines render from the report's per-target parse results,
// so no config file is read twice in one doctor run and each unknown id
// warns exactly once, counted through the reporter. hcloud is deliberately
// absent here — the dedicated hcloud block in the doctor shell owns it as
// the explicit plugin-level rule (deriving it was rejected: a core⇒hcloud
// edge would auto-provision CLI-less trims, and the union is empty on
// zero-target machines, exactly where the check matters most). devbridge is
// sandbox-resident and never probed host-side; the gateway renders through
// the shared resolution chain. PACK_USES soft edges warn once per pair when
// a used pack sits disabled in the union.
export function renderPacksDoctorSection(ctx: DoctorReporter, packReport: PackUnionReport): void {
  for (const target of packReport.targets) {
    if (target.raw === null || target.raw.trim() === '') {
      ctx.info(`Packs (${target.label}): all — DEVKIT_PACKS not set`);
      continue;
    }
    if (target.unknown.length > 0) {
      ctx.warn(`Packs (${target.label}): unknown id(s) in DEVKIT_PACKS="${target.raw}": ${target.unknown.join(', ')}`);
      ctx.raw(
        `        The MCP server will refuse to start until the value is fixed. Clear it: npx huaweicloud-devkit packs all --target <agent>`,
      );
      continue;
    }
    ctx.info(`Packs (${target.label}): ${[...target.enabled].join(', ')}`);
  }
  // Attribution for the codex contribution to the union above: a widened
  // union with no explaining line reads as a phantom.
  if (packReport.codex) {
    renderCodexPacksLine(true, packReport.codex.reason === 'plugin-installed');
  }
  // Discoverability for the secrets pack on pinned-seed installs; a real
  // mismatch (vault in use, pack trimmed) warns here and counts like the
  // other inline warns above.
  ctx.countWarn(renderSecretsPackNote(packReport));
  const { union: enabledPacksUnion, carriers } = packReport;
  if (carriers.length > 0) {
    const requiredDeps = requiredDependencies(enabledPacksUnion);
    if (requiredDeps.size === 0) {
      ctx.info('Pack dependencies: none required');
    } else {
      for (const id of DEPENDENCY_IDS.filter((entry) => requiredDeps.has(entry))) {
        if (id === 'hcloud') continue; // the dedicated hcloud block in the shell owns this check
        if (DEPENDENCIES[id].kind === 'sandbox-resident') {
          ctx.info(`${id}: sandbox-resident, not probed host-side`);
          continue;
        }
        const resolved = resolveDependencyCommand(DEPENDENCIES[id].resolution);
        if (resolved && resolved.tier !== 'fallback') {
          ctx.pass(`${id} available (${resolved.tier}: ${resolved.command})`);
        } else if (resolved) {
          ctx.warn(
            `${id} resolves only via ${resolved.command} (no persistent install) — npx huaweicloud-devkit dep install ${id}`,
          );
        } else {
          ctx.warn(`${id} not found — npx huaweicloud-devkit dep install ${id}`);
        }
      }
    }
    for (const [user, used] of Object.entries(PACK_USES)) {
      if (!enabledPacksUnion.has(user as PackId)) continue;
      for (const dep of used) {
        if (enabledPacksUnion.has(dep)) continue;
        ctx.warn(
          `Pack ${user} uses ${dep} (soft dependency) but it is disabled — its tools fall back to manual paths (npx huaweicloud-devkit install --packs <ids> to enable)`,
        );
      }
    }
  }
}

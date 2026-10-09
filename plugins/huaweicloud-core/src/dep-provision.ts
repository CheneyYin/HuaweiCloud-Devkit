import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { probeHcloud } from './hcloud-probe.ts';
import { getKooCliVersion, kooCliDownloadBase, KOO_CLI_BASE } from './koocli-version.ts';
import { detectCodeartsSandbox, printSandboxWarning } from './codearts-sandbox.ts';
import { readReceipt, receiptDir, removeReceipt, withDepLock, writeReceipt, type DepReceipt } from './dep-receipts.ts';
import {
  DEPENDENCIES,
  PACK_DEPENDENCIES,
  requiredDependencies,
  type DependencyId,
  type DependencySpec,
} from './lib/dependency-model.ts';
import type { PackId } from './lib/pack-types.ts';
import { lookupOnPath, resolveDependencyCommand, type ResolvedDependency } from './lib/dep-resolve.ts';

// Dependency provisioning: the install-time and uninstall-time halves over
// the dependency model in lib/dependency-model.ts. After the payload lands,
// the enabled packs' host binaries are provisioned per their installPolicy
// and each verified install writes a receipt (dep-receipts.ts) that later
// gates `dep uninstall`. Node builtins plus the zod-free lib/ modules only —
// this module compiles into the unbundled dist/setup-cli.js graph, where
// only undici exists at runtime.
//
// The seams, kept injectable for hermetic tests (test/dep-provision.test.ts):
// the hcloud presence probe, the two installers, the gateway resolution, and
// (uninstall) the receipt dir plus the tier-uninstall runner. Everything else
// (policy, output, ordering, refusal wording) is the contract under test.

const INFO = '  \x1b[36m[INFO]\x1b[0m';
const WARN = '  \x1b[33m[WARN]\x1b[0m';

type Log = (_line: string) => void;

// Receipt writes are best-effort bookkeeping after a verifiably successful
// install: a failed write must not fail the install (the binary is real, the
// escape hatch still exists), and an already-present binary never reaches
// this function — the provisioning loop skips before the installer runs, so
// devkit only ever claims a binary this run placed.
function recordInstallReceipt(receipt: DepReceipt): void {
  try {
    writeReceipt(receipt);
  } catch (error) {
    console.log(
      `${WARN} could not write the install receipt for ${receipt.binary}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// KooCLI (hcloud) installer — absorbed from cmdInstallHcloud's body. The CLI
// wrapper (setup-cli.ts) owns the banner and the trailing credentials note;
// this function owns download/extract/move/PATH and the privacy agreement.
// ---------------------------------------------------------------------------

// The pinned manual instructions, today's wording, shared by the installer's
// failure paths and the non-interactive provisioning path (a non-TTY session
// never downloads: it prints exactly what to run).
function printKooCliManualInstructions(log: Log = console.log): void {
  const kooCliVersion = getKooCliVersion();
  const baseUrl = kooCliDownloadBase();
  const latestUrl = `${KOO_CLI_BASE}/latest`;
  if (process.platform === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    const installDir = join(homedir(), 'hcloud');
    log(`  Manual: download ${url}, unzip to ${installDir}, add to PATH`);
    log(`  Guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_01.html`);
    return;
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const label = process.platform === 'linux' ? 'Linux' : 'macOS';
    const arch = process.arch;
    const pkg =
      process.platform === 'linux'
        ? arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-amd64'
        : arch === 'arm64'
          ? 'mac-arm64'
          : 'mac-amd64';
    const url = `${baseUrl}/huaweicloud-cli-${pkg}.tar.gz`;
    const binDir = process.platform === 'linux' ? join(homedir(), '.local', 'bin') : '/usr/local/bin';
    log(`\n[${label}] Manual install (pinned to KooCLI ${kooCliVersion || ''}):`);
    log(`  curl -LO "${url}"`);
    log(`  tar -zxvf huaweicloud-cli-${pkg}.tar.gz`);
    log(`  mv hcloud ${binDir}/`);
    log(`  hcloud version`);
    log(`\n  Or one-liner (installs LATEST, may differ from pinned ${kooCliVersion || ''}):`);
    log(`  curl -sSL ${latestUrl}/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y`);
    log(
      `  \x1b[33m⚠️  The one-liner installs the latest KooCLI. If \`hcloud version\` != ${kooCliVersion}, doctor/check_cli will warn — use the pinned download above instead.\x1b[0m`,
    );
    log(
      `\nFull guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_0${process.platform === 'linux' ? '2' : '3'}.html`,
    );
  }
}

// Privacy agreement flow, install → probe → prompt: the classification can
// only observe privacy_pending after the binary exists, so the probe runs
// after install (an already-accepted agreement must not re-prompt on
// reinstalls). Gated on the tty flag on BOTH platforms — the readline
// question hangs forever on a non-TTY stdin. Non-TTY prints the manual
// privacy command instead.
async function offerPrivacyAcceptance(executable: string, tty: boolean): Promise<void> {
  const probe = probeHcloud({ executable });
  if (probe.status === 'ok') {
    console.log('  \x1b[32mKooCLI ready (privacy agreement already accepted).\x1b[0m');
    return;
  }
  if (!tty) {
    console.log('  \x1b[33m非交互会话：请稍后在终端运行 hcloud version 并按提示接受隐私协议\x1b[0m');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const agree = await new Promise<boolean>((resolve) => {
    rl.question('\n  KooCLI requires accepting its privacy agreement. Do you accept? (y/N) ', (answer) => {
      rl.close();
      resolve(/^\s*y\s*$/i.test(answer));
    });
  });
  if (!agree) {
    console.log('  \x1b[33m请手动接受隐私协议：在终端运行 hcloud version 并按提示操作\x1b[0m');
    return;
  }
  const r = spawnSync(executable, ['version'], { input: 'y\n', encoding: 'utf8', timeout: 15000, windowsHide: true });
  console.log(
    r.status === 0
      ? '  \x1b[32mPrivacy agreement accepted. KooCLI ready.\x1b[0m'
      : process.platform === 'win32'
        ? '  \x1b[33m无法写入配置目录。请在普通终端运行: echo "y" | hcloud version\x1b[0m'
        : '  \x1b[33m无法写入配置目录。请在终端运行: hcloud version 并按提示操作\x1b[0m',
  );
}

export async function installKooCli(opts: { tty: boolean }): Promise<boolean> {
  console.log('Installing KooCLI (hcloud)...\n');

  const baseUrl = kooCliDownloadBase();
  const installDir = process.platform === 'win32' ? join(homedir(), 'hcloud') : join(homedir(), '.local', 'bin');

  if (process.platform === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    // Scratch dir per run: a fixed hcloud.zip path in the install dir
    // collides across concurrent installs, and install-time auto-provisioning
    // makes concurrent installs normal.
    const scratch = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-'));
    const zipPath = join(scratch, 'hcloud.zip');

    console.log(`[Windows] Auto-installing to ${installDir}...`);

    try {
      mkdirSync(installDir, { recursive: true });

      // Download
      console.log(`  Downloading ${url}...`);
      const psCmd = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}' -UseBasicParsing`;
      const dl = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 180000,
      });
      if (dl.status !== 0) throw new Error(`下载失败 (PowerShell exit ${dl.status})`);

      // Extract
      console.log('  Extracting...');
      const ex = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`],
        { stdio: 'inherit', windowsHide: true, timeout: 60000 },
      );
      if (ex.status !== 0) throw new Error(`解压失败 (PowerShell exit ${ex.status})`);
      if (!existsSync(join(installDir, 'hcloud.exe'))) throw new Error('hcloud.exe 未生成，可能已被安全软件拦截');

      // Clean up zip
      rmSync(zipPath, { force: true });

      // Add to user PATH (append + dedupe within the User scope only; never copy
      // session/system entries into the user PATH, and never use setx PATH which
      // overwrites the whole variable and truncates at 1024 chars).
      console.log('  Adding to user PATH...');
      const pathPs = [
        '$ErrorActionPreference = "Stop"',
        `$target = '${installDir.replace(/'/g, "''")}'`,
        '$cur = [Environment]::GetEnvironmentVariable("Path", "User")',
        'if (-not $cur) { $cur = "" }',
        '$parts = @($cur -split ";" | Where-Object { $_ -ne "" })',
        'if ($parts -notcontains $target) {',
        '  [Environment]::SetEnvironmentVariable("Path", (@($parts) + $target) -join ";", "User")',
        '  Write-Output "  Added to user PATH (deduped): $target"',
        '} else {',
        '  Write-Output "  Already in user PATH: $target"',
        '}',
      ].join('; ');
      spawnSync('powershell', ['-NoProfile', '-Command', pathPs], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 30000,
      });

      console.log(`\n\x1b[32mInstall complete.\x1b[0m`);
      console.log(`  Verify: ${join(installDir, 'hcloud.exe')} version`);

      await offerPrivacyAcceptance(join(installDir, 'hcloud.exe'), opts.tty);

      if (existsSync(join(installDir, 'hcloud.exe'))) {
        recordInstallReceipt({
          binary: 'hcloud',
          provisioner: 'devkit',
          path: join(installDir, 'hcloud.exe'),
          installedAt: new Date().toISOString(),
        });
      }

      console.log('  Or restart terminal and: hcloud version');
      return true;
    } catch (error) {
      console.log(`\n\x1b[33mAuto-install failed: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      printKooCliManualInstructions();
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
      return false;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (process.platform === 'linux' || process.platform === 'darwin') {
    const label = process.platform === 'linux' ? 'Linux' : 'macOS';
    const arch = process.arch;
    const pkg =
      process.platform === 'linux'
        ? arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-amd64'
        : arch === 'arm64'
          ? 'mac-arm64'
          : 'mac-amd64';
    const url = `${baseUrl}/huaweicloud-cli-${pkg}.tar.gz`;
    const binDir = process.platform === 'linux' ? join(homedir(), '.local', 'bin') : '/usr/local/bin';
    const binPath = join(binDir, 'hcloud');

    if (detectCodeartsSandbox() === 'sandbox') {
      printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      printKooCliManualInstructions();
      return false;
    }

    console.log(`[${label}] Auto-installing to ${binDir}...`);
    // Scratch dir per run: the fixed tmpdir()/huaweicloud-cli-<pkg>.tar.gz
    // path (and its extracted hcloud) collides across concurrent installs.
    const scratch = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-'));
    try {
      const tmpTar = join(scratch, `huaweicloud-cli-${pkg}.tar.gz`);
      console.log(`  Downloading ${url}...`);
      const dl = spawnSync('curl', ['-fL', url, '-o', tmpTar], { stdio: 'inherit', timeout: 180000 });
      if (dl.status !== 0) throw new Error(`下载失败 (curl exit ${dl.status})`);

      console.log('  Extracting...');
      const ex = spawnSync('tar', ['-xzf', tmpTar, '-C', scratch], { stdio: 'inherit', timeout: 60000 });
      if (ex.status !== 0) throw new Error(`解压失败 (tar exit ${ex.status})`);
      const extracted = join(scratch, 'hcloud');
      if (!existsSync(extracted)) throw new Error('hcloud 二进制未生成，可能已被安全软件拦截');

      try {
        mkdirSync(binDir, { recursive: true });
      } catch {}
      console.log('  Installing...');
      let mv = spawnSync('mv', [extracted, binPath], { stdio: 'inherit', timeout: 30000 });
      if (mv.status !== 0) {
        if (opts.tty) {
          // The user is present: today's interactive sudo works.
          console.log('  目标目录需要权限，尝试 sudo mv...');
          mv = spawnSync('sudo', ['mv', extracted, binPath], { stdio: 'inherit', timeout: 30000 });
          if (mv.status !== 0) throw new Error(`安装失败 (mv exit ${mv.status})`);
        } else {
          // Non-interactive: sudo -n never blocks on a password prompt; on
          // failure print the manual instructions instead of hanging.
          console.log('  目标目录需要权限，尝试 sudo -n mv...');
          const sudoMv = spawnSync('sudo', ['-n', 'mv', extracted, binPath], { stdio: 'inherit', timeout: 30000 });
          if (sudoMv.status !== 0) {
            printKooCliManualInstructions();
            return false;
          }
        }
      }

      console.log(`\n\x1b[32mInstall complete.\x1b[0m`);
      console.log(`  Verify: ${binPath} version`);

      await offerPrivacyAcceptance(binPath, opts.tty);

      if (existsSync(binPath)) {
        recordInstallReceipt({
          binary: 'hcloud',
          provisioner: 'devkit',
          path: binPath,
          installedAt: new Date().toISOString(),
        });
      }
      return true;
    } catch (error) {
      console.log(`\n\x1b[33mAuto-install failed: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      printKooCliManualInstructions();
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
      return false;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Open MCP Gateway persistent installer. uv is preferred (fast, no PEP 668
// friction, installs into ~/.local/bin where the resolution chain looks),
// then pipx, then pip3 --user.
// ---------------------------------------------------------------------------

const GATEWAY_PACKAGE = 'huaweicloud-open-mcp';
const GATEWAY_INSTALL_TIMEOUT_MS = 300_000;

export type GatewayInstallTier = 'uv' | 'pipx' | 'pip3';

export interface GatewayInstallResult {
  ok: boolean;
  tier: GatewayInstallTier | null;
}

function findHostTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const home = process.platform === 'win32' ? homedir() : env.HOME || homedir();
  const local = join(home, '.local', 'bin', `${name}${exeSuffix}`);
  return existsSync(local) ? local : lookupOnPath(name, env);
}

function outputTail(text: string, maxLines = 4): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-maxLines).join('\n  ');
}

function reportInstallFailure(tool: string, status: number | null, stdout: string, stderr: string): void {
  console.log(`${WARN} ${tool} failed (exit ${status === null ? 'timeout/kill' : status})`);
  const tail = outputTail(`${stdout}\n${stderr}`);
  if (tail) console.log(`  ${tail}`);
}

export async function installGatewayTool(): Promise<GatewayInstallResult> {
  const uv = findHostTool('uv');
  if (uv) {
    console.log(`Installing ${GATEWAY_PACKAGE} via uv (${uv})...`);
    const r = spawnSync(uv, ['tool', 'install', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'uv',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'uv' };
    }
    reportInstallFailure('uv tool install', r.status, String(r.stdout || ''), String(r.stderr || ''));
  }

  const pipx = findHostTool('pipx');
  if (pipx) {
    console.log(`Installing ${GATEWAY_PACKAGE} via pipx (${pipx})...`);
    const r = spawnSync(pipx, ['install', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'pipx',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'pipx' };
    }
    reportInstallFailure('pipx install', r.status, String(r.stdout || ''), String(r.stderr || ''));
  }

  const pip3 = findHostTool('pip3');
  if (pip3) {
    console.log(`Installing ${GATEWAY_PACKAGE} via pip3 --user (${pip3})...`);
    const r = spawnSync(pip3, ['install', '--user', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      if (process.platform === 'win32') {
        console.log(`${WARN} pip --user puts the gateway in the Python Scripts dir, which may not be on PATH.`);
        console.log(`        Prefer uv/uvx (https://docs.astral.sh/uv/) so the gateway resolves everywhere.`);
      }
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'pip3',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'pip3' };
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (/externally-managed/i.test(out)) {
      console.log(`${WARN} pip3 refused the install (PEP 668 externally-managed environment).`);
      console.log(`        Use: uv tool install ${GATEWAY_PACKAGE}`);
    } else {
      reportInstallFailure('pip3 install --user', r.status, String(r.stdout || ''), String(r.stderr || ''));
    }
    return { ok: false, tier: 'pip3' };
  }

  console.log(`${WARN} No uv, pipx, or pip3 found. Install one first (recommended: uv — https://docs.astral.sh/uv/).`);
  return { ok: false, tier: null };
}

// ---------------------------------------------------------------------------
// The policy loop over requiredDependencies output.
// ---------------------------------------------------------------------------

/** Presence facts the provisioning loop needs from an hcloud probe. */
export interface HcloudPresence {
  status: string;
  installed: boolean;
  installedVersion?: string | null;
}

/** Optional overrides; each defaults to the real implementation. */
export interface ProvisionOptions {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: Log;
  probeHcloud?: () => HcloudPresence;
  installKooCli?: (_opts: { tty: boolean }) => Promise<boolean>;
  resolveDependency?: (_id: DependencyId, _env: NodeJS.ProcessEnv) => ResolvedDependency | null;
  installGateway?: () => Promise<GatewayInstallResult>;
  confirm?: (_prompt: string) => Promise<boolean>;
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((ok) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      ok(normalized === 'y' || normalized === 'yes');
    });
  });
}

// The shared default for the resolve seam: the single resolution chain over
// the catalog's data. Provisioning and uninstall inject the same thing.
function defaultResolveDependency(id: DependencyId, env: NodeJS.ProcessEnv): ResolvedDependency | null {
  const entry = DEPENDENCIES[id];
  return entry && 'resolution' in entry ? resolveDependencyCommand(entry.resolution, env) : null;
}

export async function provisionDependencies(ids: Iterable<DependencyId>, opts: ProvisionOptions = {}): Promise<void> {
  const tty = opts.tty === true;
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const probe = opts.probeHcloud ?? (() => probeHcloud());
  const installCli = opts.installKooCli ?? ((o) => installKooCli(o));
  const resolve = opts.resolveDependency ?? defaultResolveDependency;
  const installGateway = opts.installGateway ?? (() => installGatewayTool());
  const confirm = opts.confirm ?? defaultConfirm;

  for (const id of ids) {
    // The loop reasons over the DependencySpec interface, not the catalog's
    // const literals: policy code must handle any legal spec, and the
    // literal types would narrow installPolicy to today's values.
    const spec: DependencySpec | undefined = DEPENDENCIES[id];
    if (!spec) continue;
    try {
      if (spec.kind === 'sandbox-resident') {
        log(`${INFO} ${id}: sandbox-resident (lives inside the cloud sandbox; the host never manages it)`);
        continue;
      }

      if (spec.kind === 'cli') {
        // Presence is the question; a version mismatch stays doctor's
        // warning territory. privacy_pending also counts as present: the
        // binary exists, acceptance is a terminal action.
        const presence = probe();
        if (presence.installed) {
          const version = presence.installedVersion ? ` (${presence.installedVersion})` : '';
          log(`${INFO} ${id}: present${version}, skipping install`);
          continue;
        }
        if (spec.installPolicy === 'auto') {
          if (tty) {
            const ok = await installCli({ tty });
            log(
              ok ? `${INFO} ${id}: installed` : `${WARN} ${id}: install incomplete; see the manual instructions above`,
            );
          } else {
            // Network-free non-interactive contract: print the pinned
            // manual command, never start a download.
            log(`${WARN} ${id}: not found; auto-install needs an interactive session`);
            printKooCliManualInstructions(log);
          }
          continue;
        }
        log(`${INFO} ${id}: not found. ${spec.installHint}`);
        continue;
      }

      if (spec.kind === 'managed-child') {
        const resolved = resolve(id, env);
        // Only a PERSISTENT tier (env/candidate/path) counts as present; a
        // fallback-tier (uvx) resolution does not, so policy 'prompt' still
        // offers the persistent install and the default install never
        // prompts everyone.
        if (resolved && resolved.tier !== 'fallback') {
          log(`${INFO} ${id}: present (${resolved.tier}: ${resolved.command})`);
          continue;
        }
        const hint = spec.installHint;
        if (!tty) {
          log(
            resolved
              ? `${INFO} ${id}: running via uvx (no persistent install). ${hint}`
              : `${INFO} ${id}: not found. ${hint}`,
          );
          continue;
        }
        const yes = await confirm(`Install the ${spec.title} persistently (uv tool install / pipx / pip)?`);
        if (!yes) {
          log(`${INFO} ${id}: skipped. ${hint}`);
          continue;
        }
        const result = await installGateway();
        log(
          result.ok
            ? `${INFO} ${id}: installed via ${result.tier}`
            : `${WARN} ${id}: install failed; the uvx fallback still applies. ${hint}`,
        );
        continue;
      }
    } catch (error) {
      log(`${WARN} ${id}: provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt-gated uninstall (`dep uninstall <id>`). The decision derives from
// the same model the installer used: the caller passes the effective pack
// union (setup-cli's effectivePackUnion — no second derivation exists), and
// uninstall refuses while any enabled pack requires the id. With no requiring
// pack, the receipt gates deletion: devkit removes only what it placed and
// can prove it placed. Deletion scope is binary-only — ~/.hcloud credentials
// and config stay untouched (that broader cleanup belongs to the documented
// ungated escape hatch `uninstall --clean-kocli`).
// ---------------------------------------------------------------------------

export interface DepUninstallTargets {
  /** Effective pack union across installed targets (setup-cli's effectivePackUnion). */
  enabledPacks: ReadonlySet<PackId>;
  /** Per-target enabled packs, for refusal attribution (labels from packStatusReaders). */
  carriers: ReadonlyArray<{ label: string; packs: ReadonlySet<PackId> }>;
}

export interface DepUninstallOptions {
  env?: NodeJS.ProcessEnv;
  /** Receipt directory; defaults to the shared ~/.config/huaweicloud/deps convention. */
  receiptsDir?: string;
  resolveDependency?: (_id: DependencyId, _env: NodeJS.ProcessEnv) => ResolvedDependency | null;
  runCommand?: (
    _command: string,
    _args: readonly string[],
  ) => { status: number | null; stdout: string; stderr: string };
}

export interface DepUninstallResult {
  /** False renders via console.error with exit code 1 in the dep CLI. */
  ok: boolean;
  message: string;
  detail?: string[];
}

const GATEWAY_UNINSTALL_ARGS: Record<GatewayInstallTier, readonly string[]> = {
  uv: ['tool', 'uninstall', GATEWAY_PACKAGE],
  pipx: ['uninstall', GATEWAY_PACKAGE],
  // -y because dep uninstall runs where pip's confirmation prompt would hang
  // a non-TTY session (same discipline as obsutil's -f). No --user: pip
  // rejects it on uninstall (exit 2, verified on pip 24.0), and pip removes
  // from the user site when run as that user anyway.
  pip3: ['uninstall', '-y', GATEWAY_PACKAGE],
};

const HCLOUD_ESCAPE_HATCH = 'Escape hatch: npx huaweicloud-devkit uninstall --target <agent> --clean-kocli';
const GATEWAY_ESCAPE_HATCH =
  'Escape hatch: uv tool uninstall huaweicloud-open-mcp (or pipx uninstall huaweicloud-open-mcp / pip3 uninstall -y huaweicloud-open-mcp)';

function requiringPacks(id: DependencyId, enabledPacks: ReadonlySet<PackId>): PackId[] {
  // The naming half of the refusal: the decision itself went through
  // requiredDependencies over the same edge table; this inverse lookup only
  // produces the pack names the refusal lists. Sorted so the line is
  // deterministic regardless of set order.
  return [...enabledPacks]
    .filter((pack) => (PACK_DEPENDENCIES[pack] as readonly DependencyId[]).includes(id))
    .sort((a, b) => a.localeCompare(b));
}

export function uninstallDependency(
  id: DependencyId,
  targets: DepUninstallTargets,
  opts: DepUninstallOptions = {},
): DepUninstallResult {
  const spec = DEPENDENCIES[id];
  if (!spec) return { ok: false, message: `Unknown dependency id: ${id}` };
  if (spec.kind === 'sandbox-resident') {
    return { ok: false, message: 'devbridge ships inside the cloud sandbox; the host never installs or removes it.' };
  }
  const dir = opts.receiptsDir ?? receiptDir();
  // The whole decision — requirement check, receipt read, deletion, receipt
  // removal — serializes against concurrent installs under the receipt lock.
  return withDepLock(() => {
    // The same derivation the installer used, never a second one: the
    // effective union's required-dependency set decides; requiringPacks only
    // names the packs for the refusal line.
    if (requiredDependencies(targets.enabledPacks).has(id)) {
      const requiring = requiringPacks(id, targets.enabledPacks);
      const carrierLabels = targets.carriers
        .filter((target) => [...target.packs].some((pack) => requiring.includes(pack)))
        .map((target) => target.label);
      const carriers = carrierLabels.length > 0 ? ` (installed targets: ${carrierLabels.join(', ')})` : '';
      return {
        ok: false,
        message: `Refusing to uninstall ${id}: required by enabled pack(s) ${requiring.join(', ')}${carriers}. Remove or trim those targets first: npx huaweicloud-devkit uninstall --target <agent>, or reinstall with --packs`,
      };
    }
    const receipt = readReceipt(id, dir);
    if (!receipt) {
      const escapeHatch = id === 'hcloud' ? HCLOUD_ESCAPE_HATCH : GATEWAY_ESCAPE_HATCH;
      return {
        ok: false,
        message: `Refusing to uninstall ${id}: no devkit install receipt, so this devkit did not place it and will not remove it. ${escapeHatch}`,
      };
    }
    return id === 'hcloud' ? uninstallHcloud(receipt, dir, opts) : uninstallGateway(receipt, dir, opts);
  }, dir);
}

// The only paths the uninstall side may ever hand to sudo: the catalog's
// platform candidates for hcloud (expanded with the same HOME rule the
// resolution chain uses) plus the installer's computed binPath. The receipt
// is user-writable JSON, so its recorded path is untrusted input at this
// boundary — a forged receipt must never aim sudo at an arbitrary file.
function hcloudInstallLandingSites(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const home = process.platform === 'win32' ? homedir() : env.HOME || homedir();
  const sites = new Set<string>();
  const candidates =
    process.platform === 'win32'
      ? DEPENDENCIES.hcloud.resolution.candidates.win32
      : DEPENDENCIES.hcloud.resolution.candidates.unix;
  for (const candidate of candidates) {
    sites.add(candidate.startsWith('~') ? join(home, candidate.slice(1)) : candidate);
  }
  sites.add(
    process.platform === 'win32'
      ? join(homedir(), 'hcloud', 'hcloud.exe')
      : process.platform === 'linux'
        ? join(homedir(), '.local', 'bin', 'hcloud')
        : '/usr/local/bin/hcloud',
  );
  return sites;
}

function uninstallHcloud(receipt: DepReceipt, dir: string, opts: DepUninstallOptions): DepUninstallResult {
  const env = opts.env ?? process.env;
  const resolve = opts.resolveDependency ?? defaultResolveDependency;
  // The receipt's path is the attribution: devkit deletes exactly that file.
  // When the receipt lacks one (a hand-edited receipt) the currently resolved
  // binary stands in — except an env-tier resolution: HCLOUD_BIN is the
  // user's explicit override, not devkit's placement, and a user-placed
  // binary is never touched.
  let target: string | null;
  if (receipt.path) {
    target = receipt.path;
  } else {
    const resolved = resolve('hcloud', env);
    if (resolved && resolved.tier === 'env') {
      return {
        ok: false,
        message: `Refusing to uninstall hcloud: the receipt records no path and the resolved binary is the user's HCLOUD_BIN override (${resolved.command}). ${HCLOUD_ESCAPE_HATCH}`,
      };
    }
    target = resolved ? resolved.command : null;
  }
  if (!target || !existsSync(target)) {
    removeReceipt('hcloud', dir);
    return {
      ok: true,
      message: `hcloud was already gone (nothing at ${target ?? 'the resolved location'}); removed the stale receipt.`,
    };
  }
  try {
    rmSync(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      // A concurrent removal won the race between existsSync and rmSync:
      // converge to the already-gone outcome instead of reporting failure.
      removeReceipt('hcloud', dir);
      return {
        ok: true,
        message: `hcloud was already gone (nothing at ${target}); removed the stale receipt.`,
      };
    }
    // Only permission errors escalate, and never on win32 (sudo does not
    // exist there); every other errno reports failure without escalation.
    const escalates = (errno === 'EACCES' || errno === 'EPERM') && process.platform !== 'win32';
    if (escalates && !hcloudInstallLandingSites(env).has(target)) {
      return {
        ok: false,
        message: `Refusing to remove ${target}: the receipt path is not a known devkit install location, so sudo was not attempted. Remove it manually only if you are certain devkit placed it, then re-run dep uninstall hcloud to clear the receipt.`,
      };
    }
    if (escalates) {
      // /usr/local/bin on default macOS: the installer placed the binary via
      // `sudo mv`, so a bare rmSync fails EACCES. Mirror that discipline
      // without ever blocking on a password prompt — sudo -n only, through
      // the same runCommand seam the tier uninstall uses.
      const run = opts.runCommand ?? defaultRunCommand;
      const escalated = run('sudo', ['-n', 'rm', target]);
      if (escalated.status === 0) {
        removeReceipt('hcloud', dir);
        return {
          ok: true,
          message: `Removed the devkit-installed hcloud binary: ${target} (via sudo -n rm)`,
          detail: [
            '~/.hcloud credentials and config were not touched; those are removed only by: npx huaweicloud-devkit uninstall --target <agent> --clean-kocli',
          ],
        };
      }
      return {
        ok: false,
        message: `Failed to remove ${target}: ${reason}. Remove it manually (sudo rm ${target}), then re-run dep uninstall hcloud to clear the receipt.`,
      };
    }
    return {
      ok: false,
      message: `Failed to remove ${target}: ${reason}. Remove it manually, then re-run dep uninstall hcloud to clear the receipt.`,
    };
  }
  removeReceipt('hcloud', dir);
  return {
    ok: true,
    message: `Removed the devkit-installed hcloud binary: ${target}`,
    detail: [
      '~/.hcloud credentials and config were not touched; those are removed only by: npx huaweicloud-devkit uninstall --target <agent> --clean-kocli',
    ],
  };
}

function uninstallGateway(receipt: DepReceipt, dir: string, opts: DepUninstallOptions): DepUninstallResult {
  const env = opts.env ?? process.env;
  const resolve = opts.resolveDependency ?? defaultResolveDependency;
  const tier = receipt.tier;
  if (tier) {
    // Tier-aware: a bare rm would orphan uv/pipx tool metadata. The tier tool
    // that placed the gateway is the tool that knows how to withdraw it.
    const args = GATEWAY_UNINSTALL_ARGS[tier];
    const tool = findHostTool(tier, env);
    if (tool) {
      const run = opts.runCommand ?? defaultRunCommand;
      const r = run(tool, args);
      if (r.status === 0) {
        removeReceipt('open-mcp-gateway', dir);
        return {
          ok: true,
          message: `Uninstalled the devkit-installed open-mcp-gateway via ${tier}: ${tool} ${args.join(' ')}`,
        };
      }
      const tail = outputTail(`${r.stdout}\n${r.stderr}`);
      const resolved = resolve('open-mcp-gateway', env);
      if (!resolved || resolved.tier === 'fallback') {
        // The tier tool refused because nothing is installed under it, and no
        // persistent binary resolves either: converged, receipt cleared.
        removeReceipt('open-mcp-gateway', dir);
        return {
          ok: true,
          message: `open-mcp-gateway was already gone (${tier} reported: ${tail || `exit ${r.status}`}); removed the receipt.`,
        };
      }
      return {
        ok: false,
        message: `${tier} uninstall failed (exit ${r.status ?? 'killed'}): ${tail || 'no output'}`,
        detail: [
          `A gateway binary still resolves at ${resolved.command}. Remove it manually (${GATEWAY_ESCAPE_HATCH}), then re-run dep uninstall open-mcp-gateway to clear the receipt.`,
        ],
      };
    }
  }
  // No usable tier, or the tier tool is gone: fall back to removing the
  // resolved binary directly, and say so. Candidate tier only — the env
  // override is the user's file, and a PATH hit is not provably devkit's.
  const resolved = resolve('open-mcp-gateway', env);
  if (resolved && resolved.tier === 'candidate') {
    try {
      rmSync(resolved.command);
    } catch (error) {
      return {
        ok: false,
        message: `Failed to remove ${resolved.command}: ${error instanceof Error ? error.message : String(error)}. Remove it manually, then re-run dep uninstall open-mcp-gateway to clear the receipt.`,
      };
    }
    removeReceipt('open-mcp-gateway', dir);
    return {
      ok: true,
      message: tier
        ? `${tier} is no longer installed, so its uninstall command cannot run; removed the gateway binary directly: ${resolved.command}`
        : `The receipt records no install tier; removed the gateway binary directly: ${resolved.command}`,
    };
  }
  removeReceipt('open-mcp-gateway', dir);
  return {
    ok: true,
    message: `open-mcp-gateway was already gone (no persistent install resolves); removed the stale receipt.`,
  };
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, [...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { status: r.status ?? null, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

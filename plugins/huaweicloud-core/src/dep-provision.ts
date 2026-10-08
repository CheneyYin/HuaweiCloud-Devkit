import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { probeHcloud } from './hcloud-probe.ts';
import { getKooCliVersion, kooCliDownloadBase, KOO_CLI_BASE } from './koocli-version.ts';
import { detectCodeartsSandbox, printSandboxWarning } from './codearts-sandbox.ts';
import { DEPENDENCIES, type DependencyId, type DependencySpec } from './lib/dependency-model.ts';
import { lookupOnPath, resolveDependencyCommand, type ResolvedDependency } from './lib/dep-resolve.ts';

// Dependency provisioning: the install-time half of the dependency model in
// lib/dependency-model.ts. After the payload lands, the enabled packs' host
// binaries are provisioned per their installPolicy. Node builtins only —
// this module compiles into the unbundled dist/setup-cli.js graph, where
// only undici exists at runtime.
//
// The three seams, kept injectable for hermetic tests (test/dep-provision.test.ts):
// the hcloud presence probe, the two installers, and the gateway resolution.
// Everything else (policy, output, ordering) is the contract under test.

const INFO = '  \x1b[36m[INFO]\x1b[0m';
const WARN = '  \x1b[33m[WARN]\x1b[0m';

type Log = (_line: string) => void;

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

function findHostTool(name: string): string | null {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const home = process.platform === 'win32' ? homedir() : process.env.HOME || homedir();
  const local = join(home, '.local', 'bin', `${name}${exeSuffix}`);
  return existsSync(local) ? local : lookupOnPath(name, process.env);
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
    if (r.status === 0) return { ok: true, tier: 'uv' };
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
    if (r.status === 0) return { ok: true, tier: 'pipx' };
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

export async function provisionDependencies(ids: Iterable<DependencyId>, opts: ProvisionOptions = {}): Promise<void> {
  const tty = opts.tty === true;
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const probe = opts.probeHcloud ?? (() => probeHcloud());
  const installCli = opts.installKooCli ?? ((o) => installKooCli(o));
  const resolve =
    opts.resolveDependency ??
    ((id, e) => {
      const entry = DEPENDENCIES[id];
      return entry && 'resolution' in entry ? resolveDependencyCommand(entry.resolution, e) : null;
    });
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

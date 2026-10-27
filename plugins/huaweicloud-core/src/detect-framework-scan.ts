// The scan orchestration of the detect-framework family: the public
// detectFramework entry (monorepo discovery with recursive sub-app
// scanning, then the single-project spec matcher), the PM-specific
// command patching, and the result shaping. The public result types live
// here. The public face stays src/detect-framework.ts.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { collectDeps, detectPackageManager, readPkg } from './detect-framework-pkg.ts';
import { matchFrameworkSpec } from './detect-framework-match.ts';
import type { FrameworkSpec } from './detect-framework-table.ts';

export interface SubApp {
  name: string;
  path: string;
  framework: string;
  type: string;
}

// Detection results vary by branch: framework results carry the full spec,
// monorepo results carry only tooling + sub-apps. Optional fields cover both.
export interface FrameworkDetection {
  type: string;
  framework: string;
  packageManager: string;
  rootDir: string;
  installCmd?: string | null;
  buildCmd?: string | null;
  outputDir?: string | null;
  port?: number;
  serveCmd?: string | null;
  checkUrl?: string;
  nginxType?: string;
  monorepoTool?: string;
  subApps?: SubApp[];
}

function scanSubApps(projectPath: string): SubApp[] {
  const apps: SubApp[] = [];
  for (const dir of ['apps', 'packages']) {
    const dirPath = join(projectPath, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPath = join(dirPath, entry.name);
        const subPkg = readPkg(subPath);
        if (!subPkg) continue;
        const result = detectFramework(subPath);
        if (!result) continue;
        const nameValue = subPkg.name;
        apps.push({
          name: typeof nameValue === 'string' && nameValue ? nameValue : entry.name,
          path: `${dir}/${entry.name}`,
          framework: result.framework,
          type: result.type,
        });
      }
    } catch {
      // skip unreadable directories
    }
  }
  return apps;
}

function patchCommands(result: FrameworkDetection, pm: string): FrameworkDetection {
  if (result.installCmd && result.installCmd.startsWith('npm install')) {
    if (pm === 'pnpm') result.installCmd = 'pnpm install';
    else if (pm === 'yarn') result.installCmd = 'yarn install';
  }
  if (result.buildCmd && result.buildCmd.startsWith('npm run')) {
    if (pm === 'pnpm') result.buildCmd = result.buildCmd.replace('npm run', 'pnpm run');
    else if (pm === 'yarn') result.buildCmd = result.buildCmd.replace('npm run', 'yarn run');
  }
  if (result.serveCmd && result.serveCmd.includes('npm start')) {
    if (pm === 'pnpm') result.serveCmd = result.serveCmd.replace('npm start', 'pnpm start');
    else if (pm === 'yarn') result.serveCmd = result.serveCmd.replace('npm start', 'yarn start');
  }
  return result;
}

function frameworkResult(fw: FrameworkSpec, pm: string, projectPath: string): FrameworkDetection {
  return patchCommands({ ...fw, packageManager: pm, rootDir: projectPath }, pm);
}

export function detectFramework(projectPath: string): FrameworkDetection | null {
  const pkg = readPkg(projectPath);
  const deps = collectDeps(pkg);
  const pm = detectPackageManager(projectPath, pkg);

  if (
    existsSync(join(projectPath, 'pnpm-workspace.yaml')) ||
    existsSync(join(projectPath, 'turbo.json')) ||
    existsSync(join(projectPath, 'nx.json')) ||
    existsSync(join(projectPath, 'lerna.json'))
  ) {
    const monorepoSubApps = scanSubApps(projectPath);
    return {
      type: 'monorepo',
      framework: 'Monorepo',
      monorepoTool: existsSync(join(projectPath, 'turbo.json'))
        ? 'Turborepo'
        : existsSync(join(projectPath, 'nx.json'))
          ? 'Nx'
          : existsSync(join(projectPath, 'lerna.json'))
            ? 'Lerna'
            : 'pnpm Workspace',
      subApps: monorepoSubApps,
      packageManager: pm,
      rootDir: projectPath,
    };
  }

  const spec = matchFrameworkSpec(projectPath, pkg, deps);
  return spec ? frameworkResult(spec, pm, projectPath) : null;
}

// The detect-framework family face. The frameworks spec table lives in
// detect-framework-table.ts and the package/project readers in
// detect-framework-pkg.ts; this module holds the detection orchestration
// (sub-app scanning, command patching, the branch chain) and remains the
// import path every consumer depends on — same exported names, same
// behavior.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FRAMEWORKS, type FrameworkSpec } from './detect-framework-table.ts';
import {
  collectDeps,
  detectPackageManager,
  readPkg,
  readVitepressOutDir,
  resolveAngularOutput,
} from './detect-framework-pkg.ts';

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

  if (
    existsSync(join(projectPath, 'next.config.js')) ||
    existsSync(join(projectPath, 'next.config.mjs')) ||
    existsSync(join(projectPath, 'next.config.ts')) ||
    existsSync(join(projectPath, 'next.config.cjs'))
  ) {
    return frameworkResult(FRAMEWORKS.nextjs, pm, projectPath);
  }

  if (
    existsSync(join(projectPath, 'nuxt.config.js')) ||
    existsSync(join(projectPath, 'nuxt.config.mjs')) ||
    existsSync(join(projectPath, 'nuxt.config.ts')) ||
    existsSync(join(projectPath, 'nuxt.config.cjs')) ||
    existsSync(join(projectPath, 'nuxt.config.mts'))
  ) {
    return frameworkResult(FRAMEWORKS.nuxt, pm, projectPath);
  }

  if ('@tarojs/taro' in deps) {
    return frameworkResult(FRAMEWORKS.taro, pm, projectPath);
  }

  if ('@dcloudio/uni-app' in deps || 'uni-app' in deps) {
    return frameworkResult(FRAMEWORKS.uniapp, pm, projectPath);
  }

  if (existsSync(join(projectPath, '.vitepress'))) {
    const outDir = readVitepressOutDir(projectPath);
    return frameworkResult(
      outDir ? { ...FRAMEWORKS.vitepress, outputDir: outDir } : FRAMEWORKS.vitepress,
      pm,
      projectPath,
    );
  }

  if (
    existsSync(join(projectPath, 'docusaurus.config.js')) ||
    existsSync(join(projectPath, 'docusaurus.config.ts')) ||
    existsSync(join(projectPath, 'docusaurus.config.mjs')) ||
    existsSync(join(projectPath, 'docusaurus.config.cjs'))
  ) {
    return frameworkResult(FRAMEWORKS.docusaurus, pm, projectPath);
  }

  if (existsSync(join(projectPath, 'hugo.toml')) || existsSync(join(projectPath, 'config.toml'))) {
    return frameworkResult(FRAMEWORKS.hugo, pm, projectPath);
  }

  if (existsSync(join(projectPath, '_config.yml'))) {
    return frameworkResult(FRAMEWORKS.hexo, pm, projectPath);
  }

  if (existsSync(join(projectPath, 'angular.json'))) {
    const outputDir = resolveAngularOutput(projectPath, pkg);
    return frameworkResult({ ...FRAMEWORKS.angular, outputDir }, pm, projectPath);
  }

  if (
    existsSync(join(projectPath, 'vite.config.js')) ||
    existsSync(join(projectPath, 'vite.config.mjs')) ||
    existsSync(join(projectPath, 'vite.config.ts')) ||
    existsSync(join(projectPath, 'vite.config.cjs')) ||
    existsSync(join(projectPath, 'vite.config.mts'))
  ) {
    return frameworkResult(FRAMEWORKS.vite, pm, projectPath);
  }

  if ('@vue/cli-service' in deps) {
    return frameworkResult(FRAMEWORKS.vueCli, pm, projectPath);
  }

  // CRA heuristic — main 1.1.9's exact block (6-dep union, public/index.html
  // OR root index.html). The upstream react-scripts tighten (9481ba2) applies
  // to the deps+src FALLBACK below, not to this shape.
  if (
    'react-scripts' in deps ||
    'react' in deps ||
    '@angular/core' in deps ||
    'vue' in deps ||
    'svelte' in deps ||
    'solid-js' in deps
  ) {
    if (existsSync(join(projectPath, 'public', 'index.html')) || existsSync(join(projectPath, 'index.html'))) {
      return frameworkResult(FRAMEWORKS.cra, pm, projectPath);
    }
  }

  if (
    existsSync(join(projectPath, 'index.html')) ||
    existsSync(join(projectPath, 'public', 'index.html')) ||
    existsSync(join(projectPath, 'src', 'index.html'))
  ) {
    return frameworkResult(FRAMEWORKS.static, pm, projectPath);
  }

  // Deps + src-entry fallback: a framework dependency with a src/ entry but
  // no config file — vue → vue-cli, react-scripts → CRA, svelte/solid → vite.
  // CRA here is react-scripts ONLY (the upstream tighten).
  if (pkg) {
    const entryPoints = [
      'src/main.js',
      'src/main.ts',
      'src/main.jsx',
      'src/main.tsx',
      'src/App.vue',
      'src/app.vue',
      'src/main.vue',
      'src/index.js',
      'src/index.ts',
      'src/index.jsx',
      'src/index.tsx',
    ];
    const hasEntry = entryPoints.some((p) => existsSync(join(projectPath, p)));
    if (hasEntry) {
      if ('vue' in deps || '@vue/cli-service' in deps) {
        return frameworkResult(FRAMEWORKS.vueCli, pm, projectPath);
      }
      if ('react-scripts' in deps) {
        return frameworkResult(FRAMEWORKS.cra, pm, projectPath);
      }
      if ('svelte' in deps || 'solid-js' in deps) {
        return frameworkResult(FRAMEWORKS.vite, pm, projectPath);
      }
    }
  }

  return null;
}

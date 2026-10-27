// The single-project spec matcher of the detect-framework family: the
// branch chain that maps one project directory onto a FrameworkSpec from
// the table (config-file signatures first, then dependency heuristics and
// the deps+src fallback). Returns the spec — the scan orchestration
// (detect-framework-scan.ts) turns it into the public detection result;
// the monorepo branch lives there too (its result shape is not a spec).
// The public face stays src/detect-framework.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { FRAMEWORKS, type FrameworkSpec } from './detect-framework-table.ts';
import { readVitepressOutDir, resolveAngularOutput } from './detect-framework-pkg.ts';

export function matchFrameworkSpec(
  projectPath: string,
  pkg: Record<string, unknown> | null,
  deps: Record<string, unknown>,
): FrameworkSpec | null {
  if (
    existsSync(join(projectPath, 'next.config.js')) ||
    existsSync(join(projectPath, 'next.config.mjs')) ||
    existsSync(join(projectPath, 'next.config.ts')) ||
    existsSync(join(projectPath, 'next.config.cjs'))
  ) {
    return FRAMEWORKS.nextjs;
  }

  if (
    existsSync(join(projectPath, 'nuxt.config.js')) ||
    existsSync(join(projectPath, 'nuxt.config.mjs')) ||
    existsSync(join(projectPath, 'nuxt.config.ts')) ||
    existsSync(join(projectPath, 'nuxt.config.cjs')) ||
    existsSync(join(projectPath, 'nuxt.config.mts'))
  ) {
    return FRAMEWORKS.nuxt;
  }

  if ('@tarojs/taro' in deps) {
    return FRAMEWORKS.taro;
  }

  if ('@dcloudio/uni-app' in deps || 'uni-app' in deps) {
    return FRAMEWORKS.uniapp;
  }

  if (existsSync(join(projectPath, '.vitepress'))) {
    const outDir = readVitepressOutDir(projectPath);
    return outDir ? { ...FRAMEWORKS.vitepress, outputDir: outDir } : FRAMEWORKS.vitepress;
  }

  if (
    existsSync(join(projectPath, 'docusaurus.config.js')) ||
    existsSync(join(projectPath, 'docusaurus.config.ts')) ||
    existsSync(join(projectPath, 'docusaurus.config.mjs')) ||
    existsSync(join(projectPath, 'docusaurus.config.cjs'))
  ) {
    return FRAMEWORKS.docusaurus;
  }

  if (existsSync(join(projectPath, 'hugo.toml')) || existsSync(join(projectPath, 'config.toml'))) {
    return FRAMEWORKS.hugo;
  }

  if (existsSync(join(projectPath, '_config.yml'))) {
    return FRAMEWORKS.hexo;
  }

  if (existsSync(join(projectPath, 'angular.json'))) {
    const outputDir = resolveAngularOutput(projectPath, pkg);
    return { ...FRAMEWORKS.angular, outputDir };
  }

  if (
    existsSync(join(projectPath, 'vite.config.js')) ||
    existsSync(join(projectPath, 'vite.config.mjs')) ||
    existsSync(join(projectPath, 'vite.config.ts')) ||
    existsSync(join(projectPath, 'vite.config.cjs')) ||
    existsSync(join(projectPath, 'vite.config.mts'))
  ) {
    return FRAMEWORKS.vite;
  }

  if ('@vue/cli-service' in deps) {
    return FRAMEWORKS.vueCli;
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
      return FRAMEWORKS.cra;
    }
  }

  if (
    existsSync(join(projectPath, 'index.html')) ||
    existsSync(join(projectPath, 'public', 'index.html')) ||
    existsSync(join(projectPath, 'src', 'index.html'))
  ) {
    return FRAMEWORKS.static;
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
        return FRAMEWORKS.vueCli;
      }
      if ('react-scripts' in deps) {
        return FRAMEWORKS.cra;
      }
      if ('svelte' in deps || 'solid-js' in deps) {
        return FRAMEWORKS.vite;
      }
    }
  }

  return null;
}

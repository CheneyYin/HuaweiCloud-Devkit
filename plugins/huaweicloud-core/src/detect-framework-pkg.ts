// The package/project readers of the detect-framework family: package.json
// parsing, package-manager detection, dependency collection, and the two
// output-dir resolvers (VitePress config scan, angular.json walk). Pure
// filesystem readers — no framework matching, no result shaping. The public
// face stays src/detect-framework.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asRecord } from './lib/as-record.ts';

export function readPkg(projectPath: string): Record<string, unknown> | null {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectPackageManager(projectPath: string, pkg: Record<string, unknown> | null): string {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(projectPath, 'bun.lockb'))) return 'bun';
  const declaredValue = pkg?.packageManager;
  const declared = typeof declaredValue === 'string' ? declaredValue.split('@')[0] : '';
  if (declared && ['pnpm', 'yarn', 'npm', 'bun'].includes(declared)) return declared;
  return 'npm';
}

export function collectDeps(pkg: Record<string, unknown> | null): Record<string, unknown> {
  if (!pkg) return {};
  return { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
}

export function readVitepressOutDir(projectPath: string): string | null {
  const configFiles = ['config.mts', 'config.ts', 'config.mjs', 'config.js'];
  for (const cf of configFiles) {
    const configPath = join(projectPath, '.vitepress', cf);
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, 'utf8');
      const match = content.match(/outDir\s*:\s*['"`]?([^'"`\s,}]+)['"`]?/);
      // The capture group is +-quantified; it always participates when the regex matches.
      if (match) return match[1]!;
    } catch {
      // unreadable config: fall through to the next config file; null keeps the caller's default
    }
  }
  return null;
}

export function resolveAngularOutput(projectPath: string, pkg: Record<string, unknown> | null): string {
  try {
    const angularJson = join(projectPath, 'angular.json');
    if (existsSync(angularJson)) {
      const config = asRecord(JSON.parse(readFileSync(angularJson, 'utf8')));
      const projects = asRecord(config.projects);
      const defaultProjectValue = config.defaultProject;
      const defaultProject =
        typeof defaultProjectValue === 'string' && defaultProjectValue ? defaultProjectValue : Object.keys(projects)[0];
      const project = asRecord(defaultProject !== undefined ? projects[defaultProject] : undefined);
      const architect = asRecord(project.architect);
      const build = asRecord(architect.build);
      const outputPath = asRecord(build.options).outputPath;
      if (defaultProject && typeof outputPath === 'string' && outputPath) {
        return outputPath;
      }
    }
  } catch {
    // ignore parse errors
  }
  const nameValue = pkg?.name;
  const name = typeof nameValue === 'string' && nameValue ? nameValue : 'app';
  return `dist/${name}`;
}

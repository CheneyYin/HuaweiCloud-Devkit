// The shared source-reading helpers and manifest types for the structure
// guard suites, extracted from structure.test.ts. Every structure-*.test.ts
// part imports these; the guards themselves stay in their domain files.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

// The tree-reading guards below require the generated skills tree. One loud
// precondition instead of a dozen raw ENOENT stack traces when it is absent.
assert.ok(
  existsSync(join(pluginRoot, 'skills')),
  'generated skills tree missing under plugins/huaweicloud-core/ — run: npm run build',
);

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Sources are TypeScript; a few call sites still pass legacy .mjs paths.
export function readSource(relativePath: string): string {
  const full = join(pluginRoot, relativePath.replace(/\.mjs$/, '.ts'));
  assert.ok(existsSync(full), `source file not found: ${relativePath}`);
  return readFileSync(full, 'utf8');
}

export interface PluginManifest {
  name: string;
  mcpServers?: string;
  family?: string;
  bundleFormat?: string;
  interface?: { displayName?: string };
}

export interface Marketplace {
  name: string;
  plugins: Array<{ name: string; source: { path: string } }>;
}

export interface PackageJson {
  kooCliVersion: string;
  bin?: Record<string, string>;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface JscpdConfig {
  formats: string[];
  ignore: string[];
  reporters: string[];
  threshold?: unknown;
}

export interface JscpdBaseline {
  version: number;
  fingerprints: Record<string, unknown>;
}

export interface JscpdReport {
  duplicates: Array<{ firstFile: { name: string }; secondFile: { name: string }; format: string }>;
}

export interface PackageLock {
  packages: Record<string, { resolved?: string }>;
}

export interface SafetyPolicy {
  secretKeyNamePatterns: unknown[];
  writeOperationPrefixes: unknown[];
  blockedSecretOperations: unknown[];
  credentialFilePatterns: unknown[];
}

export interface RiskRulesCatalog {
  version: string;
  rules: Array<{
    id: string;
    severity: string;
    stages: string[];
    match: { any?: unknown; all?: unknown };
    message: string;
    remediation: string;
  }>;
}

export interface McpConfig {
  mcpServers?: Record<string, { args?: string[] }>;
  mcp?: unknown;
}

export interface HooksConfig {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

export interface IconsManifest {
  icons: Array<{ id: string; name: unknown; logo: { source_url: string } }>;
}

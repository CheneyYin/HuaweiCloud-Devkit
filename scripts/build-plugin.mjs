import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(root, 'plugins', 'huaweicloud-core');
const srcDir = join(pluginDir, 'src');
const distDir = join(pluginDir, 'dist');
const stagingDir = join(pluginDir, 'dist.new');

// Compile into a staging directory and swap it in only on success. Deleting
// dist up front would leave every runtime entry point dead after a type error,
// and the failure would surface as a confusing missing-module error instead of
// the compile diagnostics.
rmSync(stagingDir, { recursive: true, force: true });

// Diagnostics go to stderr only: `npm pack --json` parses stdout as JSON, and
// this script runs as the prepack hook.
const tsc = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    join(pluginDir, 'tsconfig.json'),
    '--outDir',
    stagingDir,
  ],
  { encoding: 'utf8' },
);
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout ?? '');
  process.stderr.write(tsc.stderr ?? '');
  rmSync(stagingDir, { recursive: true, force: true });
  process.exit(tsc.status ?? 1);
}

// tsc emits scripts only. Assets read through __dirname (icons manifest, sandbox
// helper) must land next to the emitted code or dist fails at runtime.
const scriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
let copied = 0;
for (const file of walk(srcDir)) {
  if (scriptExtensions.has(extname(file))) continue;
  const dest = join(stagingDir, relative(srcDir, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  copied += 1;
}

rmSync(distDir, { recursive: true, force: true });
renameSync(stagingDir, distDir);

console.error(`[build-plugin] dist rebuilt; ${copied} non-script asset(s) copied.`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

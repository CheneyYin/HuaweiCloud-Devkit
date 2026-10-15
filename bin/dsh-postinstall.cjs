'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Detect DSH profile context ──
const cwd = process.cwd();
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profilesRoot = path.join(dshHome, 'profiles');

if (!cwd.startsWith(profilesRoot)) {
  // Not inside a DSH profile — traditional install, just print message
  console.log('\nHuaweiCloud DevKit installed. Run: npx huaweicloud-devkit install\n');
  process.exit(0);
}

// ── Inside a DSH profile ──
// The core meta-skills are disclosed natively in ~/.dsh/skills (refreshed
// here for the npm-in-profile layout, and by the setup CLI's install/update
// for the plugin-dir layout); every non-core skill stays MCP-only so
// DEVKIT_PACKS gating holds. The pack claims come from the shipped
// manifest — when it is missing or unusable this script refuses to mutate
// anything rather than guess the core set (a wrong guess would purge the
// very copies it should refresh).
const packageRoot = path.resolve(__dirname, '..');

// Rewrite the bundled patch's relative MCP server path to the absolute package
// path. Relative paths resolve against the DSH process cwd and break when DSH
// is started outside the profile directory. Idempotent: absolute paths are kept.
const bundledPatch = path.join(packageRoot, 'cordis.patch.yml');
if (fs.existsSync(bundledPatch)) {
  const relativeArg = './node_modules/huaweicloud-devkit/plugins/huaweicloud-core/dist/mcp-server.js';
  const absoluteArg = path
    .join(packageRoot, 'plugins', 'huaweicloud-core', 'dist', 'mcp-server.js')
    .replace(/\\/g, '/')
    .replace(/'/g, "''");
  const patch = fs.readFileSync(bundledPatch, 'utf8');
  const updated = patch.split(`'${relativeArg}'`).join(`'${absoluteArg}'`);
  if (updated !== patch) {
    fs.writeFileSync(bundledPatch, updated);
    console.log('HuaweiCloud DevKit: rewrote DSH patch MCP path to absolute package path');
  }
}

const skillsSrc = path.join(packageRoot, 'plugins', 'huaweicloud-core', 'skills');
const skillsDest = path.join(dshHome, 'skills');
const manifestPath = path.join(skillsSrc, '.manifest.json');

// A missing source tree is a broken package (the server fail-fasts on it at
// boot); warn loudly instead of silently skipping. A tree without usable
// pack info gets the same refusal: this script must not guess the core set.
let coreNames = null;
if (fs.existsSync(skillsSrc) && fs.existsSync(manifestPath)) {
  try {
    const packOf = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).packOf;
    if (packOf && typeof packOf === 'object' && !Array.isArray(packOf)) {
      const core = Object.entries(packOf)
        .filter(([, pack]) => pack === 'core')
        .map(([name]) => name);
      if (core.length > 0) coreNames = new Set(core);
    }
  } catch {
    // unparsable manifest: coreNames stays null and the guard below fires
  }
}

if (coreNames === null) {
  console.error(
    'HuaweiCloud DevKit: skills tree or manifest pack info missing from the package — the MCP server will refuse to start. Reinstall the huaweicloud-devkit package.',
  );
} else {
  const owned = new Set(
    fs
      .readdirSync(skillsSrc, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  // A manifest may claim core skills a partial/broken tree does not ship;
  // cpSync would throw on them and fail the whole npm install. Place what
  // exists, warn loudly about the rest — the receipt records only what was
  // actually placed.
  const placeable = [...coreNames].filter((name) => owned.has(name));
  const missing = [...coreNames].filter((name) => !owned.has(name));
  if (missing.length > 0) {
    console.error(
      `HuaweiCloud DevKit: core skill(s) claimed by the manifest but missing from the package tree: ${missing.join(', ')} — the MCP server will refuse to start. Reinstall the huaweicloud-devkit package.`,
    );
  }
  if (placeable.length === 0) {
    console.error('HuaweiCloud DevKit: no core skills placeable — skipping the native sync.');
  } else {
    // Receipt: the names a previous devkit run placed here. Untrusted
    // input — an unreadable or malformed file reads as "no receipt", which
    // only makes the cleanup more conservative about what it may delete.
    const receiptPath = path.join(skillsDest, '.huaweicloud-devkit-native.json');
    let remembered = new Set();
    if (fs.existsSync(receiptPath)) {
      try {
        const names = JSON.parse(fs.readFileSync(receiptPath, 'utf8')).names;
        if (Array.isArray(names)) remembered = new Set(names.filter((n) => typeof n === 'string'));
      } catch {
        // treat as no receipt
      }
    }
    fs.mkdirSync(skillsDest, { recursive: true });
    let purged = 0;
    for (const name of placeable) {
      fs.rmSync(path.join(skillsDest, name), { recursive: true, force: true });
      fs.cpSync(path.join(skillsSrc, name), path.join(skillsDest, name), { recursive: true });
    }
    for (const entry of fs.readdirSync(skillsDest, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const claimed = owned.has(entry.name) || remembered.has(entry.name);
      if (claimed && !coreNames.has(entry.name)) {
        fs.rmSync(path.join(skillsDest, entry.name), { recursive: true, force: true });
        purged++;
      }
    }
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({ names: [...placeable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }, null, 2) + '\n',
    );
    if (purged > 0) {
      console.log(
        `HuaweiCloud DevKit: cleaned ${purged} stale native skill cop${purged === 1 ? 'y' : 'ies'} (non-core skills are MCP-disclosed)`,
      );
    }
    console.log(
      `HuaweiCloud DevKit: refreshed ${placeable.length} core skill cop${placeable.length === 1 ? 'y' : 'ies'} in ${skillsDest}`,
    );
  }
}

console.log('MCP server will be available after DSH restart.');
console.log('\n\u001b[1m\u001b[36m  首次使用请配置环境：\u001b[0m');
console.log('  1. 安装 KooCLI：npx huaweicloud-devkit install-hcloud');
console.log('  2. 配置凭证：  npx huaweicloud-devkit auth init');
console.log('  3. 重启 DSH 会话后即可使用');
console.log('  或者直接在 DSH 中对 Agent 说：帮我安装华为云 KooCLI 并配置凭证\n');

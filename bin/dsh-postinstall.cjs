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
// Skills are server data disclosed over MCP; the DSH patch points the server
// at the package root, so no copy is made. Pre-MCP installs left native
// copies in ~/.dsh/skills/ — purge them (ownership-precise: only names the
// shipped tree still carries).
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

if (fs.existsSync(skillsSrc) && fs.existsSync(skillsDest)) {
  const owned = new Set(
    fs
      .readdirSync(skillsSrc, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  let purged = 0;
  for (const entry of fs.readdirSync(skillsDest, { withFileTypes: true })) {
    if (entry.isDirectory() && owned.has(entry.name)) {
      fs.rmSync(path.join(skillsDest, entry.name), { recursive: true, force: true });
      purged++;
    }
  }
  if (purged > 0) {
    console.log(
      `HuaweiCloud DevKit: cleaned ${purged} stale native skill cop${purged === 1 ? 'y' : 'ies'} (skills are MCP-disclosed)`,
    );
  }
}

console.log('MCP server will be available after DSH restart.');
console.log('\n\u001b[1m\u001b[36m  首次使用请配置环境：\u001b[0m');
console.log('  1. 安装 KooCLI：npx huaweicloud-devkit install-hcloud');
console.log('  2. 配置凭证：  npx huaweicloud-devkit auth init');
console.log('  3. 重启 DSH 会话后即可使用');
console.log('  或者直接在 DSH 中对 Agent 说：帮我安装华为云 KooCLI 并配置凭证\n');

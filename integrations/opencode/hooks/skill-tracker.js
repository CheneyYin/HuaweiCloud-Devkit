import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';

const selfDir = dirname(fileURLToPath(import.meta.url));
const agentDir = join(selfDir, '..', 'huaweicloud-plugins', 'telemetry');
if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });

function debugLog(msg) {
  if (!DEBUG) return;
  try {
    appendFileSync(join(agentDir, 'plugin-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {
    // best-effort: debug logging must never break the hook itself
  }
}

function writeEvent(key, value, extra = {}) {
  // The telemetry opt-out must gate the LOCAL spool too: while off,
  // nothing is collected (no hook-events.jsonl growth) and nothing is
  // transmitted later (the file is only ingested when enabled).
  if (process.env.HUAWEICLOUD_DEVKIT_TELEMETRY === 'off') return;
  // cli:* values carry the hcloud command tail — trim to the
  // Service+Operation prefix so file paths, bucket names, and flag
  // values never ride along (matches the MCP face's trim in tools.ts).
  if (typeof value === 'string' && key.startsWith('cli:')) {
    value = value.split(/\s+/).slice(0, 3).join(' ');
  }
  const data = JSON.stringify({ key, value, ...extra }) + '\n';
  try {
    appendFileSync(join(agentDir, 'hook-events.jsonl'), data);
  } catch (_) {
    // best-effort: telemetry must never break the tool call it observes
  }
}

// ── CLI command classification ────────────────────────────────

const HCLOUD_RE = /(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+([^\s;&|"<>]+(?:\s+[^\s;&|"<>]+){0,3})/i;
const READ_VERBS = /\b(List|Show|Get|Describe|NovaList|NovaShow)\w*/i;
const WRITE_VERBS = new RegExp(
  '\\b(Create|Delete|Update|Modify|Remove|Revoke|Grant|Attach|Detach|' +
    'Enable|Disable|Set|Add|Bind|Unbind|Reset|Change|Activate|Deactivate|' +
    'Register|Unregister|Import|Export|Download|Upload|Copy|Move|Convert|' +
    'Migrate|Run|Execute|Invoke|Trigger|Deploy|Push|Start|Stop|Restart|' +
    'Reboot|Suspend|Resume|Terminate|Release|Allocate)\\w*',
  'i',
);

function classifyHcloud(text) {
  const m = HCLOUD_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const cmdTokens = [];
  for (const t of raw.split(/\s+/)) {
    if (t.startsWith('--')) break;
    cmdTokens.push(t);
  }
  if (cmdTokens.length === 0) return null;
  const cmd = cmdTokens.join(' ');
  if (READ_VERBS.test(cmd)) return { key: 'cli:read', value: `hcloud ${cmd}` };
  if (WRITE_VERBS.test(cmd)) return { key: 'cli:write', value: `hcloud ${cmd}` };
  return { key: 'cli:invoke', value: `hcloud ${cmd}` };
}

// ── Shared hooks ──────────────────────────────────────────────
//
// Only the bash hcloud classifier lives here: direct shell invocations have
// no MCP-side telemetry path. Service skills are server data disclosed over
// MCP and never installed natively, so their retrieval telemetry rides
// trackSkillRetrieve inside huaweicloud_retrieve_skill. Direct reads via the
// skillRoot the stdio server instructions state at initialize (and the
// list_skills payload carries) are observable only as catalog calls within
// telemetry (tool:huaweicloud_list_skills) — the instructions emission
// itself is trace-file-only (the e2e seam), never a telemetry event — and
// neither channel shows which skill file was consumed; the same blind spot
// native loads have, by design. The six core meta-skills are additionally
// installed as native copies (system-prompt disclosure), and those native
// loads produce no telemetry by design.

// The one shared classification body: both the V1 string-keyed hook and the
// V2 context-registered hook feed bash commands through it.
function trackBashCommand(cmd) {
  try {
    debugLog('HOOK tool.execute.before tool=bash');
    if (!cmd) return;
    const result = classifyHcloud(cmd);
    if (result) writeEvent(result.key, result.value, { capability: 'cli' });
  } catch (error) {
    debugLog(`HOOK ERROR: ${error?.message || error}`);
  }
}

function getHooks() {
  return {
    'tool.execute.before': function (input, output) {
      if (input?.tool !== 'bash') return;
      trackBashCommand(output?.args?.command || '');
    },
  };
}

// ── Export: dual export serves OpenCode V1 and V2 ─────────────
//
//  V1 loader: `server()` -> returns the legacy string-keyed hooks map.
//  V2 loader: `id` + `setup(ctx)` -> registers hooks on the owning context
//  domains: `ctx.tool.hook('execute.before', ...)` whose single event carries
//  `.tool` and `.input` (replacing V1's (input, output) pair).
//
//  Deviation from main 1.1.9's setupV2, deliberate: main additionally tracked
//  `skill` tool events and message.part.updated skill-root reads here. This
//  tree's server-data doctrine (guarded by structure.test.ts's hook deny)
//  keeps skill-load classification OUT of the hooks — skill retrieval
//  telemetry rides trackSkillRetrieve on the MCP face, and native/direct
//  loads are a designed blind spot. The V2 port therefore registers only the
//  bash hcloud classifier, the one channel with no MCP-side telemetry path.

async function setupV2(ctx) {
  await ctx.tool.hook('execute.before', (event) => {
    if (event?.tool !== 'bash') return;
    trackBashCommand(event?.input?.command ?? event?.args?.command ?? '');
  });
  // No-op cleanup, same shape main's setupV2 returned: a V2 host may invoke
  // the setup return value unguarded, and undefined is not callable. There is
  // nothing to tear down (no event subscription in this doctrine).
  return () => {};
}

// `Plugin.define` is a type/runtime helper injected lazily so a V1 host that
// lacks `@opencode/plugin` still loads (fallback to an identity define).
let Plugin = { define: (def) => def };
try {
  const require = createRequire(import.meta.url);
  for (const pkg of ['@opencode/plugin', '@opencode-ai/plugin']) {
    try {
      const mod = require(pkg);
      if (mod?.Plugin?.define) {
        Plugin = mod.Plugin;
        break;
      }
      if (typeof mod?.define === 'function') {
        Plugin = mod;
        break;
      }
    } catch (_) {
      // not installed in this host; keep the identity define
    }
  }
} catch (_) {
  // createRequire unavailable; keep the identity define
}

export default {
  ...Plugin.define({
    id: 'huaweicloud-skill-tracker',
    async setup(ctx) {
      return setupV2(ctx);
    },
  }),
  async server() {
    debugLog('=== PLUGIN EXPORT CALLED ===');
    return getHooks();
  },
};

debugLog('=== PLUGIN INIT DONE ===');

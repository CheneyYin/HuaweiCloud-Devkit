import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets, resolveAgentartsTier, resolveAgentartsGroupTokens } from './safety-policy.mjs';
import { getProxySettings } from './proxy/proxy-config.mjs';
import { resolveCredentialsWithRuntime } from './auth/credentials.mjs';
import { createApprovalTokenStore, scrubPositionalSecrets, argsMatchPlanBinding } from './approval-tokens.mjs';

// agentarts (agentarts-sdk) approval wrapper. The command classification
// (tiers, labels, aliases) is the shared policy.json agentartsCommandPolicy
// consumed by both hook layers; this wrapper is the third consumer, so
// wrapper/hook/Python tiers can never drift — ONE measured exception: the
// wrapper's effectiveAgentartsClassification RE-DERIVES the tier for
// help-in-value-slot argvs (trap 26a; the hook half is the recorded
// follow-up), so for those argvs wrapper and hook intentionally differ.
// Measured facts behind the classification and the traps handled here are
// recorded in docs/agentarts-pr0-findings.md (agentarts-sdk 0.1.7).

const __dirname = dirname(fileURLToPath(import.meta.url));

export const READONLY_TIMEOUT_MS = 60_000;
// Measured per-operation approved-tier defaults (PR0 D11 + the e2e run):
// launch's docker build dominates (~2-3 min), destroy is a control-plane
// delete (~10s but leave headroom), the invoke family carries the CLI's own
// 900s request timeout, everything else is quick control-plane I/O.
const OPERATION_TIMEOUT_MS = {
  launch: 600_000,
  destroy: 300_000,
  invoke: 900_000,
  'runtime invoke': 900_000,
  'runtime upload-files': 900_000,
  'runtime download-files': 900_000,
};
export const DEFAULT_APPROVED_TIMEOUT_MS = 120_000;
const LARGE_OUTPUT_THRESHOLD = 50_000;
const OUTPUT_DIR = join('/tmp', 'huaweicloud-devkit');

// The pinned agentarts-sdk version. Primary source: safety/policy.json
// (agentartsSdkVersion) — that file ships with src/ in EVERY install layout
// (repo, npm dependency, and the per-agent copies setup makes). Fallback:
// the repo/package.json field. Never throws: an unresolvable pin degrades to
// null (doctor warns, wrapper hints say "the pinned version").
export function pinnedSdkVersion() {
  try {
    const policy = JSON.parse(readFileSync(join(__dirname, '..', 'safety', 'policy.json'), 'utf8'));
    if (typeof policy.agentartsSdkVersion === 'string' && policy.agentartsSdkVersion) {
      return policy.agentartsSdkVersion;
    }
  } catch {
    /* fall through to the package.json candidate */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.agentartsSdkVersion === 'string' ? pkg.agentartsSdkVersion : null;
  } catch {
    return null;
  }
}

// The Huawei Cloud PyPI mirror behind every taught install command and the
// devkit-managed install (agentarts-sdk ships on PyPI; the mirror is the
// restricted-network-friendly default, same posture as the README's npm
// mirror guidance, with the same lag caveat: fall back to official PyPI
// when the mirror lacks a newly pinned version). Single canonical literal —
// validate-package.mjs pins the skills' `-i <url>` literals against it.
export const AGENTARTS_SDK_MIRROR = 'https://mirrors.huaweicloud.com/repository/pypi/simple';

// The devkit-managed venv (provisioned by `npx huaweicloud-devkit
// install-agentarts`). Lives under the devkit state root, NOT ~/.huaweicloud
// — that directory is the hooks' credentialFilePatterns namespace.
export function agentartsVenvDir() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'agentarts-venv');
}

export function agentartsVenvBin() {
  return join(
    agentartsVenvDir(),
    process.platform === 'win32' ? join('Scripts', 'agentarts.exe') : join('bin', 'agentarts'),
  );
}

const agentartsApprovals = createApprovalTokenStore('agentarts');

// Measured non-interactive requirements (PR0 fixtures):
// - `destroy` prompts Confirm.ask unless --yes/-y.
// - `memory install/uninstall` prompt for platform selection when target is
//   omitted and for confirmation unless --yes; target must be explicit.
// - `memory delete` prompts unless --force/-f (NOT --yes — a different flag).
// - `memory create --output json` is REQUIRED for the one-time api_key to be
//   printed at all (the table branch prints only Space ID/Status, losing the
//   key permanently — commands.py:121-131).
// - `gateway delete`/`delete-target` prompt with NO skip flag at all — the
//   wrapper hard-stops and points at the user terminal.
// - bare `agentarts config` is an interactive wizard — a subcommand is
//   required.
// - `--bearer-token`/`-bt` exists on 7 commands; argv is process-list
//   visible, so the wrapper rejects it outright (env-var auth only).
// Per-operation canonical flags: what to append when the caller omitted it,
// and how to detect an explicit occurrence (never double-append).
const CANONICAL_FLAGS = new Map([
  ['destroy', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory install', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory uninstall', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory delete', { append: ['--force'], present: [/^(--force|-f)$/] }],
]);
const INTERACTIVE_BLOCKED_SUBCOMMANDS = new Set(['gateway delete', 'gateway delete-target']);
const MEMORY_INSTALL_TARGETS = new Set(['hermes', 'claude', 'codex', 'opencode', 'openclaw']);
// Built-in memory strategies (memory create --strategies). Source of truth:
// the StrategyType enum in agentarts/sdk/memory/inner/config.py (the pinned
// SDK cannot be patched from this repo, so the set is mirrored here).
// MEASURED are e2e-measured server-accepted; `event` is enum-evidenced only
// (it gets a provenance warning, not silence). The 0.1.7 CLI help neither
// marks the flag required nor lists the values ("Built-in memory strategies
// (comma-separated)"), while the server rejects a strategy-less create with
// HTTP 400 [AgentArts.01010400] — after the CLI has already created an
// orphan API key (key-before-space order, e2e-measured 2026-10-21). Every
// agent-facing string below is DERIVED from these sets; do not hand-spell
// the list elsewhere.
export const MEMORY_STRATEGY_MEASURED = new Set(['semantic', 'episodic', 'user_preference', 'summary']);
export const MEMORY_STRATEGY_BUILTINS = new Set([...MEMORY_STRATEGY_MEASURED, 'event']);

// CLI resolution priority: AGENTARTS_BIN env > the devkit-managed venv >
// PATH 'agentarts'. The env override stays the escape hatch (e2e scratch
// venvs, user-managed installs); the venv probe makes the devkit-managed
// pinned install shadow an arbitrary PATH version (the doctor compares
// against the same pin). The probe tests the CLI BINARY, not the venv
// directory — a half-built venv never shadows PATH.
export function resolveAgentartsCommand() {
  const explicit = process.env.AGENTARTS_BIN;
  if (explicit) {
    return process.platform === 'win32' && !explicit.toLowerCase().endsWith('.exe') ? `${explicit}.exe` : explicit;
  }
  const venvBin = agentartsVenvBin();
  if (existsSync(venvBin)) return venvBin;
  return process.platform === 'win32' ? 'agentarts.exe' : 'agentarts';
}

// Classification is delegated to resolveAgentartsTier (safety-policy.mjs) —
// the SAME function the hook decision path consumes, so wrapper tiers and
// hook denials can never drift. Aliases (deploy→launch, configure→config)
// are applied inside it; unknown groups/subcommands keep the policy
// defaultTier (fail-safe).
const classifyAgentartsInvocation = resolveAgentartsTier;

// Value-taking flags per memory subcommand, transcribed from the 0.1.7
// fixtures (test/fixtures/agentarts/help-tree/memory_*.txt). A token
// immediately following one of these is its VALUE (click consumes
// dash-prefixed tokens as values), never an option — the foundation for
// both the help-slot detection below and the flag scanning. create and
// update take the identical value-flag set; install and uninstall take
// none (only --global/--yes booleans).
const MEMORY_CREATE_UPDATE_VALUE_FLAGS = new Set([
  '--ttl',
  '-t',
  '--description',
  '-d',
  '--extract-idle',
  '--extract-tokens',
  '--extract-messages',
  '--strategies',
  '-s',
  '--tags',
  '--vpc-id',
  '--subnet-id',
  '--region',
  '-r',
  '--output',
  '-o',
]);
export const MEMORY_SUBCOMMAND_VALUE_FLAGS = new Map([
  ['create', MEMORY_CREATE_UPDATE_VALUE_FLAGS],
  ['update', MEMORY_CREATE_UPDATE_VALUE_FLAGS],
  ['delete', new Set(['--region', '-r'])],
  ['get', new Set(['--region', '-r', '--output', '-o'])],
  ['list', new Set(['--limit', '-l', '--offset', '--region', '-r', '--output', '-o'])],
  ['status', new Set(['--region', '-r', '--output', '-o'])],
  ['install', new Set()],
  ['uninstall', new Set()],
]);

// Single-pass, value-slot-aware scan of a memory-family argv, mirroring
// click: a bare value-taking flag CONSUMES the next token (dash-prefixed
// included); inline `--flag=v` / `-sv` forms are self-contained; --help/-h
// at an option position is eager help. Returns the LAST --strategies and
// --output values ('' when the flag dangles, null when absent — only
// meaningful on subcommands that take those flags), whether a GENUINE
// help token exists, and the dangling flag (if any). Help matching is
// case-insensitive to mirror the classifier it overrides
// (safety-policy.mjs lowercases every token); flag matching stays
// case-sensitive like click. `from` is the index AFTER the group and
// subcommand tokens: value flags are only parsed there (pre-subcommand
// tokens parse at the ROOT context, which has no value flags on 0.1.7),
// while help detection covers the whole argv (root --help is genuine
// help). Scope of the click model: for argvs click executes, the scan's
// view matches click's; positional-arity divergences (extra positionals,
// unknown root options) pass the plan and fail at run, where the
// usage-error signatures catch the click error.
function scanMemoryArgs(args, valueFlags, from = 0) {
  let strategies = null;
  let output = null;
  let region = null;
  let genuineHelp = false;
  let danglingFlag = null;
  const consumedDashPrefixed = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i >= from && valueFlags.has(arg)) {
      const next = args[i + 1];
      if (next === undefined) {
        danglingFlag = arg;
        if (arg === '--strategies' || arg === '-s') strategies = '';
        else if (arg === '--output' || arg === '-o') output = '';
        else if (arg === '--region' || arg === '-r') region = '';
      } else {
        if (/^-/.test(next)) consumedDashPrefixed.push({ flag: arg, value: next });
        if (arg === '--strategies' || arg === '-s') strategies = next;
        else if (arg === '--output' || arg === '-o') output = next;
        else if (arg === '--region' || arg === '-r') region = next;
      }
      i += 1;
      continue;
    }
    if (/^(--help|-h)$/i.test(arg)) {
      genuineHelp = true;
      continue;
    }
    if (i < from) continue;
    if (arg.startsWith('--strategies=')) strategies = arg.slice(13);
    else if (arg.startsWith('--output=')) output = arg.slice(9);
    else if (arg.startsWith('--region=')) region = arg.slice(9);
    else if (/^-s\S+$/.test(arg)) strategies = arg.slice(2);
    else if (/^-o\S+$/.test(arg)) output = arg.slice(2);
    else if (/^-r\S+$/.test(arg)) region = arg.slice(2);
  }
  return { strategies, output, region, genuineHelp, danglingFlag, consumedDashPrefixed };
}

// The classifier's help short-circuit is position-blind (safety-policy.mjs,
// findings trap 26): a --help/-h token in a VALUE slot (`--strategies
// --help`, `-d --help`) still collapses the classification to the bare
// `memory` group — skipping the memory-create guards AND de-escalating an
// approved cloud write to local (which the wrapper would then steer to
// unapproved Bash execution). Re-derive the effective classification from
// the clean shape whenever that happens; the executed args stay original.
// Shared by the plan tool and the readonly runner so the two surfaces can
// never return opposite verdicts on the same argv. Also returns the
// memory-family scan (null for non-memory argv) so the plan's guards and
// canonicalizer consume ONE scan instead of re-scanning.
function effectiveAgentartsClassification(rawArgs, options = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  let classification = classifyAgentartsInvocation(args, options);
  // Group/subcommand resolution comes from the SAME exported helper the
  // classifier consumes (aliases included) — a policy alias mapping into
  // the memory family resolves identically here, and the mirror cannot
  // drift from the classifier it overrides.
  const { groupIndex, group, sub } = resolveAgentartsGroupTokens(args, options.policy);
  const valueFlags = group === 'memory' && sub !== undefined ? MEMORY_SUBCOMMAND_VALUE_FLAGS.get(sub) : undefined;
  // A leading --version/-v is a GENUINE root terminal flag (click prints
  // the version and exits — no cloud write, no subcommand parsing): the
  // classifier's local verdict stands, and the plan's dangling-flag guard
  // must not reject such argvs either. Only the help-in-value-slot
  // collapse is re-derived.
  const rootVersionPrefixed = args.slice(0, groupIndex).some((tok) => /^(--version|-v)$/i.test(tok));
  if (valueFlags === undefined) return { classification, memoryScan: null, rootVersionPrefixed };
  const memoryScan = scanMemoryArgs(args, valueFlags, groupIndex + 2);
  if (classification.operation !== `memory ${sub}` && !memoryScan.genuineHelp && !rootVersionPrefixed) {
    classification = classifyAgentartsInvocation(['memory', sub], options);
  }
  return { classification, memoryScan, rootVersionPrefixed };
}

// Canonicalize args into the exact form the wrapper would execute: append
// the measured per-operation flag set where the caller omitted it. The
// approval token binds to THESE args, so what the user approves is what
// runs.
function canonicalizeArgs(rawArgs, classification, memoryScan) {
  const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  // memory create (not in CANONICAL_FLAGS): `--output json` is the ONLY
  // branch that prints the one-time api_key, so a non-json output is a
  // plan-level rejection (same posture as --bearer-token), not a rewrite —
  // rewriting bound approval args is argv surgery the token hash cannot
  // survive. The scan comes from the plan's single effective-classification
  // pass (value-slot-aware: a `-d -ojson` argv has NO --output — click
  // consumes -ojson as the description); for a memory-create operation it
  // is always non-null (the plan computed it), and a null here fails LOUD
  // rather than silently re-scanning with the wrong offset. Case-sensitive
  // value check — the CLI compares `output == "json"` (commands.py), so
  // `JSON` would silently take the table branch and lose the one-time
  // api_key. Last occurrence wins (click semantics). A dangling value flag
  // never reaches here (the plan rejects it first — the appended tokens
  // would be eaten as its value).
  if (classification.operation === 'memory create') {
    const { output } = memoryScan;
    if (output === null) return [...args, '--output', 'json'];
    if (output !== 'json') return null;
    return args;
  }
  const rule = CANONICAL_FLAGS.get(classification.operation);
  if (!rule) return args;
  if (!args.some((a) => rule.present.some((re) => re.test(a)))) {
    return [...args, ...rule.append];
  }
  return args;
}

function argvContainsBearerToken(args) {
  // Prefix-match EVERY spelling: -bt, -bt=SECRET, -btSECRET, -BT, and the
  // long forms --bearer-token[=SECRET|SECRET]. Only the exact -bt/--bearer-token
  // spellings are valid click parses; every other form is a click usage
  // error ("No such option: -b") — rejecting them costs nothing (doomed
  // argvs) and keeps the token out of the transcript and approvals.json.
  return args.some((arg) => /^--bearer-token/i.test(arg) || /^-bt/i.test(arg));
}

// The memory six take --region (install/uninstall have no region flag).
// Derived from the fixture-pinned value-flag table so the roster cannot
// drift from it. Trap 15: their help text claims a cn-north-4 default —
// the actual code fallback is cn-southwest-2 (constant.py get_region),
// which is also the only e2e-measured region. The plan surfaces that lie
// whenever the agent follows the help text or omits the flag.
const MEMORY_REGION_SUBCOMMANDS = new Set(
  [...MEMORY_SUBCOMMAND_VALUE_FLAGS].filter(([, flags]) => flags.has('--region')).map(([sub]) => sub),
);
const TRAP15_NOTE =
  'The CLI help claims cn-north-4 as the default region — that text is wrong (findings trap 15): the actual code fallback is cn-southwest-2 (get_region, constant.py), and cn-southwest-2 is the only e2e-measured region.';

function planningGuidance(classification, canonicalArgs, memoryScan) {
  const notes = [];
  if (classification.unregistered) {
    notes.push(
      `agentarts ${classification.operation || '(unknown)'} is not in the measured command registry (agentarts-sdk 0.1.7); classified fail-safe as cloud-write. Run \`agentarts ${classification.operation} --help\` first to verify the command shape.`,
    );
  }
  if (classification.operation === 'config' || classification.group === 'config') {
    notes.push('Bare `agentarts config` is an interactive wizard; a subcommand (set, get, list, …) is required.');
  }
  if (INTERACTIVE_BLOCKED_SUBCOMMANDS.has(classification.operation)) {
    notes.push(
      `agentarts ${classification.operation} prompts for confirmation with NO non-interactive flag; the wrapper cannot run it safely — execute it in your own terminal.`,
    );
  }
  if (
    (classification.operation === 'memory install' || classification.operation === 'memory uninstall') &&
    canonicalArgs.length > 0
  ) {
    const sub = canonicalArgs.find((a) => MEMORY_INSTALL_TARGETS.has(a.toLowerCase()));
    if (!sub) {
      notes.push(
        'memory install/uninstall requires an explicit target platform (hermes, claude, codex, opencode, openclaw) — omitting it starts an interactive selection.',
      );
    }
    if (!canonicalArgs.some((a) => /^(--yes|-y)$/.test(a))) {
      notes.push('memory install/uninstall requires --yes to skip its confirmation prompts.');
    }
  }
  const memorySub = classification.operation?.startsWith('memory ')
    ? classification.operation.slice('memory '.length)
    : null;
  if (memorySub && MEMORY_REGION_SUBCOMMANDS.has(memorySub)) {
    // '' (inline --region=) normalizes to absent — source-true: the SDK's
    // Python `if region:` treats it as unset. A dangling --region is
    // hard-rejected before notes ever run.
    const region = memoryScan?.region || null;
    if (region && region.toLowerCase() === 'cn-north-4') {
      notes.push(
        `--region cn-north-4 follows the CLI's wrong help text. ${TRAP15_NOTE} Pass --region cn-southwest-2 — the only control-plane region and the only e2e-measured one.`,
      );
    } else if (region === null) {
      notes.push(
        `No --region on memory ${memorySub}. ${TRAP15_NOTE} Omitting the flag resolves through the SDK env chain (HUAWEICLOUD_SDK_REGION/HUAWEICLOUD_REGION/OS_REGION_NAME — stripped in wrapper child envs) to cn-southwest-2; in your own terminal an exported HUAWEICLOUD_SDK_REGION wins, and some sibling skills' install guides export it. Pass --region explicitly to guard against future default drift.`,
      );
    }
  }
  return notes;
}

export function planAgentartsCommand(rawArgs, options = {}) {
  const providedArgs = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  // Rejection payloads are redacted EXACTLY like the success path: a bare
  // positional secret (config set-env HUAWEICLOUD_SDK_AK <value>) must
  // never ride a reject response into the transcript.
  const reject = (error) => ({
    ok: false,
    service: 'AgentArts',
    executable: resolveAgentartsCommand(),
    args: scrubPositionalSecrets(redactSecrets(providedArgs), 'agentarts'),
    error,
  });
  if (argvContainsBearerToken(providedArgs)) {
    return reject(
      'Rejected: --bearer-token/-bt places the token in the process list. Authenticate via HUAWEICLOUD_SDK_AK/SK environment injection instead (see the huawei-agentarts skill).',
    );
  }

  const { classification, memoryScan, rootVersionPrefixed } = effectiveAgentartsClassification(providedArgs, options);
  const executable = resolveAgentartsCommand();

  // A dangling value flag on a memory-family argv is a click parse error
  // ("Option '--X' requires an argument." — nothing reaches the server),
  // and it would CANNIBALIZE the canonical flags this wrapper appends:
  // `memory create x --strategies semantic --description` + appended
  // `--output json` parses as description='--output' with 'json' left as
  // an extra positional (usage error at run, caught); WITHOUT the name
  // positional filled, 'json' fills it instead — the create parses
  // cleanly, runs the TABLE branch, and the one-time api_key is lost
  // silently. Reject at plan; nothing valid is rejected (click errors on
  // the same argv). Root-terminal argvs (`--version memory list --limit`,
  // `... create --help --strategies`) are EXEMPT: click prints the
  // version/help and exits before subcommand args are ever parsed.
  if (memoryScan?.danglingFlag && !memoryScan.genuineHelp && !rootVersionPrefixed) {
    return reject(
      `Rejected: ${classification.operation} ends with a dangling ${memoryScan.danglingFlag} (value missing) — click fails at CLI argument parsing ("Option '${memoryScan.danglingFlag}' requires an argument."), and any flag appended after it would be consumed as its value. Supply the value or drop the flag.`,
    );
  }

  // Friction fix 1 (e2e-measured 2026-10-21): the server requires at least
  // one memory strategy — HTTP 400 [AgentArts.01010400] — and the failed
  // create has ALREADY orphaned an API key (the CLI creates the key before
  // the space). The CLI help hides both the required-ness and the legal
  // values, so a first attempt without --strategies always failed after a
  // cloud round-trip. Reject at plan time, before the approval flow and
  // any cloud call, with the legal values inline (derived from the sets —
  // never hand-spelled). The scan is value-slot-aware (click semantics), so
  // the validated value is the one the CLI actually executes — a
  // mispositioned flag (`--strategies --help`, `-d -summary`) can never
  // masquerade as a strategy.
  let strategies = null;
  let rawSegments = null;
  if (classification.operation === 'memory create') {
    // Validation runs on the RAW comma-split: the CLI sends the string
    // unnormalized, so 'semantic, episodic' (padded segment) and
    // 'semantic,' (empty segment) must stay OBSERVABLE (warning) instead
    // of being silently normalized away — whether the server trims is
    // unmeasured. Only empty-after-filter and flag-like values reject.
    rawSegments = memoryScan.strategies === null ? [] : memoryScan.strategies.split(',');
    strategies = rawSegments.map((s) => s.trim()).filter(Boolean);
    // Flag- OR '='-leading values are mispositioned/attached-form
    // accidents: click parses `-s=semantic` as the value '=semantic' (no
    // '='-stripping for short options) and sends it verbatim — the same
    // server 400 + orphan key as a missing value. The '=' case matters
    // because KooCLI's universal --param=value convention trains every
    // agent to write it.
    if (strategies.length === 0 || rawSegments.some((s) => /^[-=]/.test(s.trim()))) {
      const measuredList = [...MEMORY_STRATEGY_MEASURED].join(', ');
      const enumOnlyList = [...MEMORY_STRATEGY_BUILTINS].filter((s) => !MEMORY_STRATEGY_MEASURED.has(s)).join(', ');
      return reject(
        `Rejected: memory create requires --strategies with at least one plain value. A missing or empty value reaches the server and fails with HTTP 400 [AgentArts.01010400] ("至少需要一种内置或自定义记忆策略"); a value starting with '-' is a mispositioned flag, and one starting with '=' is an attached-form accident (click parses -s=semantic as the value '=semantic' — no '='-stripping for short options); both are sent verbatim and server-rejected the same way. A dangling flag fails earlier, at CLI argument parsing. A create that reaches the server without a valid strategy still orphans the API key the CLI creates just before the space. Pass at least one built-in strategy, comma-separated: ${measuredList} (e2e-measured) or ${enumOnlyList} (enum-evidenced, not yet e2e-measured). Flag names are case-sensitive and unknown flags are rejected by the CLI — check spelling (--STRATEGIES is not --strategies). Example: agentarts memory create <name> --strategies semantic,episodic (the wrapper appends --output json for the one-time key capture).`,
      );
    }
  }
  const blocked = INTERACTIVE_BLOCKED_SUBCOMMANDS.has(classification.operation);
  const bareConfig = classification.group === 'config' && !classification.subcommand;
  const missingTarget =
    (classification.operation === 'memory install' || classification.operation === 'memory uninstall') &&
    !providedArgs.some((a) => MEMORY_INSTALL_TARGETS.has(String(a).toLowerCase()));
  const hardStop = blocked || bareConfig || missingTarget;

  const canonicalArgs = hardStop ? providedArgs : canonicalizeArgs(providedArgs, classification, memoryScan);
  if (canonicalArgs === null) {
    return reject(
      'Rejected: memory create with a non-json --output permanently loses the one-time api_key (the table branch prints only Space ID/Status). Re-run with --output json (or omit it — the wrapper canonicalizes to json).',
    );
  }
  // A literal <redacted> at a SECRET slot cannot be approved: its plan
  // display is byte-identical to a redacted real secret, so the user
  // cannot tell "secret redacted for display" from "the literal
  // placeholder is about to be written" — and the hash-exact replay
  // would execute it. Legit literals elsewhere (descriptions, invoke
  // payloads) still plan and replay fine. Sentinel probe: swap the
  // literals for a sentinel, run the scrubber — a flagged position is
  // one where the scrubber HIT (probe shows <redacted>) AND the original
  // arg was itself the literal (a real secret scrubs to <redacted> too,
  // but its original arg is the real value, not the literal).
  const slotSentinel = '\u0000plan-placeholder-probe\u0000';
  const slotProbe = scrubPositionalSecrets(
    canonicalArgs.map((a) => (a === '<redacted>' ? slotSentinel : a)),
    'agentarts',
  );
  if (slotProbe.some((a, idx) => a === '<redacted>' && canonicalArgs[idx] === '<redacted>')) {
    return reject(
      'Rejected: a literal <redacted> sits at a secret slot — the plan cannot bind it (its display would be indistinguishable from a redacted real secret, and the approved replay would write the literal string). Re-plan with the actual secret value; at run time, re-supply the real value wherever a plan displays <redacted>.',
    );
  }
  const notes = planningGuidance(classification, canonicalArgs, memoryScan);
  if (memoryScan?.consumedDashPrefixed?.length > 0) {
    // Mid-argv cannibalization stays a WARNING (a dash-leading value is
    // legitimate click input: `-d -overview`), but it can silently
    // restructure the command when a positional is unfilled —
    // `--description --output json` parses as description='--output' with
    // 'json' filling the required NAME positional. The interpolated tokens
    // go through the SAME redaction pipeline as plan.args: a secret-shaped
    // token in a value slot must never ride the warning into the
    // transcript.
    for (const { flag, value } of memoryScan.consumedDashPrefixed) {
      const [safeFlag, safeValue] = scrubPositionalSecrets(redactSecrets([flag, value]), 'agentarts');
      notes.push(
        `${safeFlag} consumes ${safeValue} as its value (click parses dash-prefixed tokens that way) — if ${safeValue} was meant as a flag, supply ${safeFlag}'s value or drop it; an unfilled positional can silently receive the token after it.`,
      );
    }
  }
  if (strategies) {
    // Unknown RAW segments are a warning, not a rejection: only the
    // missing/flag-like cases are measured-certain failures, and the
    // server makes the final call on names (fail-safe posture, same as
    // unregistered commands). The exact-match check keeps padded/empty
    // segments observable. The provenance note for enum-evidenced values
    // is an INDEPENDENT if — `event,bogus` gets both. Both lists derive
    // from the sets, never hand-spelled.
    const unknown = rawSegments.filter((s) => !MEMORY_STRATEGY_BUILTINS.has(s));
    if (unknown.length > 0) {
      // The display segments go through redactSecrets — the same inline
      // key=value masking plan.args gets: a secret pasted into the wrong
      // flag must never ride the warning into the transcript.
      const display = redactSecrets(unknown).map((s) => (s.trim() === '' ? '(empty segment)' : s));
      notes.push(
        `--strategies raw segments outside the known built-in set (${[...MEMORY_STRATEGY_BUILTINS].join(', ')}): ${display.join(', ')} — the CLI sends the string unnormalized, so padded or empty segments may be rejected server-side; through this CLI only the built-ins can be valid (custom needs a definition it cannot pass, trap 24), and a rejected create still orphans the API key.`,
      );
    }
    const enumOnly = strategies.filter((s) => MEMORY_STRATEGY_BUILTINS.has(s) && !MEMORY_STRATEGY_MEASURED.has(s));
    if (enumOnly.length > 0) {
      notes.push(
        `--strategies includes ${enumOnly.join(', ')}: enum-evidenced only, not yet e2e-measured on the server.`,
      );
    }
  }
  // Display/storage surfaces are POSITIONAL-SCRUBBED on top of redactSecrets:
  // `config set-env HUAWEICLOUD_SDK_AK <value>` must not carry the raw value
  // into the transcript or approvals.json. The approval token binds to the
  // REAL canonical args; re-supply the real values at run time (replace
  // <redacted> placeholders).
  const displayArgs = scrubPositionalSecrets(redactSecrets(canonicalArgs), 'agentarts');
  const command = [executable, ...displayArgs].map((arg) => quoteShellArg(arg)).join(' ');

  const plan = {
    ok: true,
    service: 'AgentArts',
    executable,
    args: displayArgs,
    command,
    executableBlock: command,
    tier: classification.tier,
    labels: classification.labels,
    operation: classification.operation,
    warnings: notes,
    // Exit codes cannot be trusted (0.1.7 fails with exit 0); the run layer
    // parses output for failure signatures instead.
    safeToRun: classification.tier === 'readonly',
  };

  if (hardStop) {
    plan.safeToRun = false;
    plan.hardStop = true;
    plan.executionBlock = `${classification.operation} cannot run through the wrapper (${
      blocked
        ? 'interactive confirm with no skip flag'
        : bareConfig
          ? 'interactive wizard'
          : 'interactive target-platform selection'
    }) — run it in your own terminal.`;
    return plan;
  }

  if (classification.tier === 'local') {
    plan.executionBlock =
      'Local-tier command: run via Bash directly (hook-covered). No approval needed; `agentarts dev` is a long-running server the agent manages (background start, poll ping, kill).';
    return plan;
  }

  if (classification.tier === 'blocked') {
    // Kept for custom policies: the stock policy no longer blocks any
    // command (PR11 unblocked memory create/update/delete).
    plan.executionBlock = `${classification.operation} is blocked by toolkit policy in this release — run it in your own terminal if needed.`;
    return plan;
  }

  if (classification.tier === 'approved' || classification.tier === 'unknown') {
    plan.approvalToken = agentartsApprovals.create(canonicalArgs);
    plan.approvalGuidance = `Cloud write${
      classification.labels.length ? ` (${classification.labels.join(', ')})` : ''
    }. Present the exact command to the user; on explicit approval, call huaweicloud_agentarts_run_approved_command with these args and the approvalToken. Where the plan displays <redacted> for a secret, re-supply the REAL value at run time — the approval binds the real args, and a literal <redacted> is rejected. Otherwise the user runs it in their own terminal.`;
  }
  return plan;
}

// Allowlist-style child environment: NEVER spread process.env (ambient
// variables, including stray credentials, must not leak into the child), and
// inject HUAWEICLOUD_SDK_AK/SK from the devkit runtime credential state —
// injection replaces, not adds. TLS trust anchors ride along with the proxy
// vars (a MITM proxy without its CA bundle turns into confusing TLS errors).
export function buildChildEnv(options = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.COMSPEC = process.env.COMSPEC;
  }
  const proxy = getProxySettings();
  if (proxy?.https_proxy) env.HTTPS_PROXY = proxy.https_proxy;
  if (proxy?.http_proxy) env.HTTP_PROXY = proxy.http_proxy;
  if (proxy?.no_proxy) env.NO_PROXY = proxy.no_proxy;

  if (options.injectCredentials !== false) {
    let creds;
    try {
      creds = resolveCredentialsWithRuntime({ allowMissing: true });
    } catch {
      creds = null;
    }
    if (creds?.ak && creds?.sk) {
      env.HUAWEICLOUD_SDK_AK = creds.ak;
      env.HUAWEICLOUD_SDK_SK = creds.sk;
    } else {
      // The measured auth chain is env → ~/.huaweicloud/credentials profile
      // → metadata: without injected env vars the CLI silently authenticates
      // from an unmanaged profile file (possibly a different account). The
      // wrapper contract is env-or-fail — never an accidental profile hit.
      env.HUAWEICLOUD_SDK_CREDENTIALS_FILE = '/dev/null';
    }
  }
  // Drop empty entries so spawn does not pass empty-string variables.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined || env[key] === '') delete env[key];
  }
  return env;
}
// The CLI returns exit code 0 even on failure (measured: full traceback,
// exit 0) — success must be decided from the output. Signatures measured
// against 0.1.7: rich ERROR log lines, Python tracebacks, "Failed to …"
// operation errors, EOF-aborted prompts ("Aborted."), the "× ERROR:" echo
// the CLI prints for operation errors (no data-plane endpoint, auth
// failure), and the deploy stage's "Error building image:" (docker build
// failure surfaced through the CLI).
const FAILURE_SIGNATURE_RE =
  /Traceback \(most recent call last\)| - ERROR - |^Failed to |^Aborted\.$|^× ERROR:|^Error building image:/m;
// Usage errors (click argument parsing) are STDERR-ONLY and rich-boxed on
// 0.1.7 — all five forms captured 2026-10-21 against the pinned binary:
// `No such option: -h`, `Missing argument 'name'.`, `Got unexpected extra
// argument(s) …`, `No such command 'memry'. Did you mean 'memory'?`,
// `Option '--limit' requires an argument.` (the dangling form prints ONLY
// the box); each multi-line form is preceded by a `Usage: agentarts …`
// line and a `Try 'agentarts … --help' for help.` line; exit code 2,
// honored as a failure signal by the close handler for BOTH run paths —
// the stderr signatures exist to catch the measured exit-0 failure mode.
// Scoped to stderr ONLY — and the Try alternative source-anchored to the
// agentarts spelling — because invoke-family stderr can carry
// agent-generated text (any click-style tool prints the same English
// line), and a loose match there must not flip a successful cloud write
// to failed (a spurious failure on memory create would skip BOTH the
// one-time-key capture and its scrub — loss and leak in one step). The
// box-body forms carry no agentarts token, so they are additionally
// SKIPPED for the invoke family (the only operations whose stderr can
// carry child output): the close handler's exit-2 check (usage errors
// exit 2, measured) is the backstop there.
// FAILURE_SIGNATURE_RE deliberately keeps scanning both streams: the
// CLI's own failure output is split across them (measured). Residual
// risk, recorded in findings trap 26b: invoke-family output quoting a
// traceback/ERROR line could false-positive the older signatures.
const USAGE_ERROR_TRY_RE = /^Try 'agentarts(?: .*)? --help' for help\.$/m;
const USAGE_ERROR_BOX_RE =
  /^│ (?:No such option|No such command|Missing argument|Got unexpected extra|Option '.*' requires an argument)/m;
// Operations whose stderr can carry CHILD output (invoke family streams
// the invoked agent's output; launch streams docker-build logs, whose RUN
// steps are user-controlled). For these, BOTH usage-error signatures are
// skipped and the close handler's exit-2 backstop (usage errors exit 2,
// measured) is the detector.
const INVOKE_FAMILY_OPERATIONS = new Set([
  'invoke',
  'launch',
  'runtime invoke',
  'runtime exec-command',
  'runtime upload-files',
  'runtime download-files',
  'runtime start-session',
  'runtime stop-session',
]);

export function detectFailure(stdout, stderr, operation = null) {
  if (FAILURE_SIGNATURE_RE.test(`${stdout}\n${stderr}`)) return true;
  // Child-output-bearing operations (INVOKE_FAMILY_OPERATIONS — invoke
  // family + launch/docker-build): BOTH usage-error signatures are
  // skipped; the close handler's exit-2 backstop (usage errors exit 2,
  // measured) covers every real form, so the signatures add only false
  // positives there — an invoked agent or build step that shells out to
  // a failing `agentarts …` command echoes exactly these lines on the
  // shared stderr.
  if (operation !== null && INVOKE_FAMILY_OPERATIONS.has(operation)) return false;
  if (USAGE_ERROR_TRY_RE.test(stderr || '')) return true;
  return USAGE_ERROR_BOX_RE.test(stderr || '');
}

export function saveLargeOutput(scrubbedStdout) {
  if (scrubbedStdout.length <= LARGE_OUTPUT_THRESHOLD) return null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const filePath = join(OUTPUT_DIR, `agentarts-output-${Date.now()}.json`);
    // The CALLER pre-scrubs (the create-path split/join removes the exact
    // key value BEFORE this point); the redactSecrets pass here is
    // defense-in-depth for every other credential shape (including the
    // quoted JSON api_key form — trap 27). 0600 regardless.
    writeFileSync(filePath, redactSecrets(scrubbedStdout), { encoding: 'utf8', mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

function defaultTimeoutMs(classification) {
  return OPERATION_TIMEOUT_MS[classification.operation] ?? DEFAULT_APPROVED_TIMEOUT_MS;
}

function quoteShellArg(arg) {
  const s = String(arg);
  return /^[\w./=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

async function runAgentarts(canonicalArgs, classification, options = {}) {
  const executable = resolveAgentartsCommand();
  const timeoutMs =
    options.timeoutMs ?? (classification.tier === 'readonly' ? READONLY_TIMEOUT_MS : defaultTimeoutMs(classification));
  const childEnv = buildChildEnv(options);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    // stdin is IGNORED, never piped and never written: interactive prompts
    // get EOF and abort (measured) instead of hanging until timeout, and no
    // caller-supplied stdin can ever reach the child.
    const child = spawn(executable, canonicalArgs, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd || undefined,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // Key capture + payload scrubbing + truncation, shared by the close
    // and TIMEOUT paths: a timed-out create whose stdout already carries
    // the key JSON must not lose the unrecoverable key (after SIGKILL the
    // close handler no-ops through the settled guard). The ONE-TIME
    // api_key is captured from the RAW stdout BEFORE redactSecrets runs
    // (the redacted payload would only ever yield <redacted>),
    // UNCONDITIONAL on the failure verdict — a false-positive failure
    // signature (old signatures scan both streams, residual trap 26b)
    // must not gate the scrub. Extraction itself is the gate: genuine
    // failure output carries no api_key JSON, so nothing is written or
    // reported for it.
    const captureAndScrub = () => {
      const memoryApiKey = extractMemoryApiKey(stdout, classification.operation);
      let keyWriteFailed = false;
      if (memoryApiKey) {
        if (memoryApiKey.file === null) {
          // The server-controlled space id is not path-safe (charset
          // validated in the extractor) — never build a path from it, and
          // never interpolate the RAW id into the remediation text.
          keyWriteFailed = true;
        } else {
          try {
            mkdirSync(dirname(memoryApiKey.file), { recursive: true });
            writeFileSync(memoryApiKey.file, `${memoryApiKey.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
          } catch {
            // The create itself succeeded; a failed key capture must not
            // flip the outcome — but the payload must NOT claim the key
            // was saved: it is scrubbed from this output and shown only
            // once by the CLI, so a write failure loses it irrecoverably.
            keyWriteFailed = true;
          }
        }
      }
      // The captured one-time key is scrubbed from the text explicitly
      // (split/join on the exact value) BEFORE the generic redaction pass —
      // belt-and-suspenders over redactSecrets, which since trap 27 also
      // masks the quoted JSON api_key shape but cannot know this specific
      // key. A successful memory create carries exactly that shape.
      const payloadStdout =
        memoryApiKey && stdout.includes(memoryApiKey.apiKey)
          ? stdout.split(memoryApiKey.apiKey).join('<redacted>')
          : stdout;
      const safeStdout = redactSecrets(payloadStdout);
      // The large-output side file gets the SAME scrubbed text: a real
      // memory create prints ~53KB (trap 25) — above the 50KB threshold —
      // so an unscrubbed side file would leak the one-time key on every
      // successful create. When the side file is written, the payload
      // stdout is TRUNCATED to a head + pointer (the hcloud wrapper's
      // pattern) — otherwise the ~53KB rides the payload into the
      // transcript anyway and the side file offloads nothing. spaceId /
      // memoryApiKeyFile / the failure verdict are separate fields, so
      // nothing actionable is lost to the truncation.
      const largeOutputFile = saveLargeOutput(safeStdout);
      const payloadStdoutFinal = largeOutputFile
        ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
        : safeStdout;
      return {
        stdout: payloadStdoutFinal,
        durationMs: Date.now() - startedAt,
        ...(largeOutputFile ? { largeOutputFile } : {}),
        ...(memoryApiKey
          ? {
              spaceId: memoryApiKey.spaceId,
              ...(keyWriteFailed
                ? {
                    memoryApiKeyCaptureFailed: true,
                    memoryApiKeyNote:
                      memoryApiKey.file === null
                        ? 'FAILED to save the one-time data-plane API key — the server returned a space id that is not path-safe (see the spaceId field of this result; validate it before any use). The key is scrubbed from this output and printed only once by the CLI, so it is unrecoverable: delete the space and recreate it.'
                        : `FAILED to save the one-time data-plane API key (write error at ${memoryApiKey.file}) — it is scrubbed from this output and printed only once by the CLI, so it is unrecoverable. Delete and recreate the space (memory delete ${memoryApiKey.spaceId} --force, then memory create).`,
                  }
                : {
                    memoryApiKeyFile: memoryApiKey.file,
                    memoryApiKeyNote: `One-time data-plane API key saved (0600): ${memoryApiKey.file}. It is never printed — the user reads the file directly (data-plane env: HUAWEICLOUD_SDK_MEMORY_API_KEY).`,
                  }),
            }
          : {}),
      };
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: `agentarts command timed out after ${timeoutMs} ms.`,
        timedOut: true,
        stderr: redactSecrets(stderr),
        ...captureAndScrub(),
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        error: `Failed to launch ${executable}: ${error.message}. Install the SDK: npx huaweicloud-devkit install-agentarts (or pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i ${AGENTARTS_SDK_MIRROR}; AGENTARTS_BIN points at a non-PATH install).`,
      });
    });
    child.on('close', (code) => {
      // Single capture per run: a timed-out (or spawn-failed) invocation
      // already settled the promise with its own captureAndScrub pass —
      // without this guard the late close would run the whole block AGAIN
      // (a second orphaned side file ~30s later, and a late duplicate key
      // write that can contradict the reported capture-failure).
      if (settled) return;
      // Exit-code contract (measured): operational failures exit 0, usage
      // errors exit 2. Exit 2 is honored as a usage-error-certain failure
      // signal — it is the backstop that makes the invoke-family box-form
      // exemption sound (their stderr can carry child output, so the box
      // signatures alone would miss the box-only dangling form). Other
      // nonzero codes stay ignored (unmeasured; the output signatures
      // remain the detector for them).
      const failed = detectFailure(stdout, stderr, classification.operation) || code === 2;
      finish({
        ok: !failed,
        exitCode: code,
        stderr: redactSecrets(stderr),
        failureDetected: failed,
        ...captureAndScrub(),
      });
    });
  });
}

// Extract the one-time memory api_key (+ space id) from a successful
// `memory create --output json` stdout. Dual-path defense: JSON.parse the
// trimmed output first (rich print_json should emit clean JSON), fall back
// to the same regex style the e2e uses for memory list (real output can
// carry log noise around the payload).
function extractMemoryApiKey(rawStdout, operation) {
  if (operation !== 'memory create') return null;
  const text = String(rawStdout || '');
  let apiKey = null;
  let spaceId = null;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object') {
      apiKey = typeof parsed.api_key === 'string' ? parsed.api_key : null;
      spaceId = typeof parsed.id === 'string' ? parsed.id : null;
    }
  } catch {
    /* fall through to the regex path */
  }
  if (!apiKey) {
    const keyMatch = /"api_key"\s*:\s*"([^"]+)"/.exec(text);
    if (keyMatch) apiKey = keyMatch[1];
  }
  if (!spaceId) {
    // Fallback regex: match the TOP-LEVEL "id" key only (quoted boundary
    // rejects suffixed keys like "api_key_id"/"agency_id" — those are the
    // realistic collision sources in a noisy create response).
    const idMatch = /(?<![_a-zA-Z])"id"\s*:\s*"([^"]+)"/.exec(text);
    if (idMatch) spaceId = idMatch[1];
  }
  if (!apiKey || !spaceId) return null;
  const file = memoryApiKeyFile(spaceId);
  return { apiKey, spaceId, file: file.ok ? file.path : null };
}

// The 0600 key-file path for a memory space's one-time data-plane api_key,
// shared by the create-path writer and the data-plane read bridge. The
// space id must pass the charset gate BEFORE path construction: an id like
// 'x/../../../.ssh/evil' must never steer path operations outside the
// state root.
export function memoryApiKeyFile(spaceId) {
  if (typeof spaceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(spaceId)) {
    return { ok: false, error: 'space_id must match /^[A-Za-z0-9_-]+$/ (server-controlled id; path safety).' };
  }
  const stateRoot = process.env.HUAWEICLOUD_HOME || homedir();
  return { ok: true, path: join(stateRoot, '.config', 'huaweicloud', `agentarts-memory-api-key-${spaceId}.txt`) };
}

// The env-or-fail credential contract: without devkit credentials the CLI
// would silently authenticate from ~/.huaweicloud/credentials (measured auth
// chain) — possibly a different account. Reject with a clear pointer
// instead of an accidental profile hit or a raw auth traceback.
function missingCredentialError() {
  return {
    ok: false,
    error:
      'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files.',
  };
}

function hasInjectableCredentials() {
  try {
    const creds = resolveCredentialsWithRuntime({ allowMissing: true });
    return Boolean(creds?.ak && creds?.sk);
  } catch {
    return false;
  }
}

export async function runAgentartsReadonlyCommand(rawArgs, options = {}) {
  const providedArgs = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  if (argvContainsBearerToken(providedArgs)) {
    return { ok: false, error: 'Rejected: --bearer-token/-bt is argv-visible; use env-var auth.' };
  }
  // Same effective classification as the plan tool (trap 26): a --help
  // token in a value slot must not collapse an approved-tier write to
  // local here either — the two surfaces can never return opposite
  // verdicts on the same argv.
  const { classification } = effectiveAgentartsClassification(providedArgs, options);
  if (classification.tier !== 'readonly') {
    return {
      ok: false,
      error: `Not a read-only agentarts command (tier: ${classification.tier}). ${
        classification.tier === 'approved'
          ? 'Use huaweicloud_agentarts_run_approved_command with an approval token.'
          : classification.tier === 'local'
            ? 'Local-tier commands run via Bash directly.'
            : 'This command is not available through the wrapper in this release.'
      }`,
    };
  }
  if (options.injectCredentials !== false && !hasInjectableCredentials()) {
    return missingCredentialError();
  }
  const result = await runAgentarts(providedArgs, classification, options);
  return { service: 'AgentArts', operation: classification.operation, tier: 'readonly', ...result };
}

export async function runAgentartsApprovedCommand(args = {}) {
  if (args.approvedByUser !== true) {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }
  const token = String(args.approvalToken || '');

  // Same precise JSON contract as the hcloud trio (#745).
  const inspection = agentartsApprovals.inspect(token);
  if (inspection.state === 'already_consumed') {
    return { status: 'ok', outcome: 'already_processed' };
  }
  if (inspection.state === 'expired') {
    return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
  }
  if (inspection.state === 'not_found') {
    return { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' };
  }

  const providedArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  // Binding validation runs against the INSPECTION entry BEFORE the token
  // is consumed: a placeholder/mismatch rejection must NOT burn the
  // approval — the corrected retry reuses the same token instead of
  // reporting already_processed for a command that never ran.
  // Shared binding check (approval-tokens.mjs, same one the hcloud runner
  // consumes): hash-exact, with scrub-tolerance ONLY for replaced secret
  // values — and a literal '<redacted>' placeholder (bare or inline
  // --param=<redacted>) is always rejected (executing the placeholder
  // would silently write the literal string as the secret).
  const binding = argsMatchPlanBinding(inspection.entry, providedArgs);
  if (!binding.ok) {
    throw new Error(
      binding.reason === 'placeholder'
        ? 'Provided args contain a literal <redacted> placeholder — replace the placeholders with the actual secret values (the plan displays them redacted; the approval binds the real args).'
        : 'Provided args do not match the approved plan. Use the args you planned; if the plan shows <redacted> placeholders for secrets, replace them with the actual values (the plan already carries the non-interactive flags the wrapper will execute).',
    );
  }

  const plan = planAgentartsCommand(providedArgs);
  if (!plan.ok || plan.hardStop || plan.tier !== 'approved') {
    return {
      status: 'rejected',
      code: 'PLAN_NO_LONGER_EXECUTABLE',
      detail: plan.executionBlock || plan.error || `tier changed to ${plan.tier}`,
    };
  }

  const credentialError = missingCredentialError();
  if (hasInjectableCredentials() === false) {
    return { status: 'rejected', code: 'NO_DEVKIT_CREDENTIALS', detail: credentialError.error };
  }

  const stored = agentartsApprovals.consume(token);
  if (!stored) {
    const recheck = agentartsApprovals.inspect(token);
    if (recheck.state === 'expired') return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
    if (recheck.state === 'already_consumed') return { status: 'ok', outcome: 'already_processed' };
    return { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' };
  }

  const result = await runAgentarts(providedArgs, plan, {
    timeoutMs: args.timeoutMs,
    cwd: args.cwd,
  });
  return {
    status: 'ok',
    approved: true,
    operation: plan.operation,
    ...result,
  };
}

// List agent runtimes: an SDK-only capability. The 0.1.7 CLI has NO list
// command (the 43 help fixtures prove it), so this runs an inline snippet
// through the python that owns the resolved agentarts CLI. Two contracts
// differ from the CLI runners, both deliberate:
// - Parameters travel as a SEPARATE argv element (sys.argv[1]) parsed with
//   json.loads — never woven into code. A JSON string is not a Python
//   literal (true/false/null), so weaving would silently corrupt any
//   future boolean/null parameter.
// - The snippet's exit codes are OURS and trustworthy (the CLI's exit-0
//   failure trap does not apply to code we control): 0 = success,
//   3 = agentarts module missing (advance to the next python candidate),
//   1 = failure. detectFailure still runs as the second defense layer.
const LIST_AGENTS_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.service.runtime_client import RuntimeClient',
  '    from agentarts.sdk.utils.constant import get_control_plane_endpoint',
  '    params = json.loads(sys.argv[1])',
  '    client = RuntimeClient(control_endpoint=get_control_plane_endpoint(params.get("region")))',
  '    kwargs = {}',
  '    if params.get("agent_name"):',
  '        kwargs["agent_name"] = params["agent_name"]',
  '    if params.get("limit") is not None:',
  '        kwargs["limit"] = params["limit"]',
  '    if params.get("offset") is not None:',
  '        kwargs["offset"] = params["offset"]',
  '    agents = client.get_agents(**kwargs)',
  '    print(json.dumps(agents, ensure_ascii=False))',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Python candidates for the snippet: the sibling python of a path-resolved
// CLI first (the devkit venv's or AGENTARTS_BIN's own interpreter — the
// one that certainly has the SDK when the CLI resolved from there), then
// the PATH fallbacks. A bare PATH-resolved CLI has no sibling; an activated
// venv's bin dir is already on PATH, so python3 resolves to it there.
export function pythonCandidatesForAgentarts() {
  const resolved = resolveAgentartsCommand();
  const candidates = [];
  if (resolved.includes('/') || resolved.includes('\\')) {
    candidates.push(join(dirname(resolved), process.platform === 'win32' ? 'python.exe' : 'python'));
  }
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');
  if (process.platform !== 'win32') candidates.push('python');
  return [...new Set(candidates)];
}

export function runPythonSnippet(candidate, args, childEnv, timeoutMs, stdinData = null) {
  return new Promise((resolve) => {
    const child = spawn(candidate, args, {
      shell: false,
      windowsHide: true,
      env: childEnv,
      // 'pipe' for stdin only when the caller sends data — the write bridge
      // transports the request JSON via stdin (a conversation batch can
      // exceed the kernel's per-argument limit in argv, and argv is
      // process-list visible).
      stdio: [stdinData === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdinData !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData, 'utf8');
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr, spawnError: error }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}

// Shared SDK-snippet execution loop: try every python candidate, advance
// the chain only on "this python cannot run the SDK" (module missing /
// spawn error) — a candidate that found the SDK and failed (auth, network,
// API error) is FINAL, retrying on another interpreter would only mask the
// real error. shapeResult(result, candidate) builds the per-tool payload;
// the loop owns the chain, the module-missing remediation, and the
// runCandidate seam (tests override it; production runs runPythonSnippet).
export async function runOverPythonCandidates({
  args,
  childEnv,
  timeoutMs,
  runCandidate,
  shapeResult,
  stdinData = null,
}) {
  for (const candidate of pythonCandidatesForAgentarts()) {
    const result = await (runCandidate || ((c) => runPythonSnippet(c, args, childEnv, timeoutMs, stdinData)))(
      candidate,
      args,
      childEnv,
      stdinData,
    );
    const moduleMissing =
      result.exitCode === 3 || /ModuleNotFoundError|AGENTARTS_SDK_MISSING/.test(result.stderr || '');
    if (result.spawnError || moduleMissing) continue;
    return shapeResult(result, candidate);
  }
  return {
    ok: false,
    error: `No python candidate could import agentarts (tried: ${pythonCandidatesForAgentarts().join(', ')}). Install the SDK: npx huaweicloud-devkit install-agentarts (or pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i ${AGENTARTS_SDK_MIRROR}).`,
  };
}

// Read-only agent listing through the SDK API. Env-or-fail, allowlist child
// env, redaction, and the readonly timeout are the same contracts as the
// CLI readonly runner; only the executable (python, not the CLI) and the
// exit-code contract (ours, see LIST_AGENTS_SNIPPET) differ.
export async function listAgentartsAgents(params = {}, options = {}) {
  if (options.injectCredentials !== false && !hasInjectableCredentials()) {
    return missingCredentialError();
  }
  // The request carries ONLY what the caller passed (plus region, which the
  // wrapper must supply: the SDK's region env chain is not in the allowlist
  // child env). Omitted pagination keys keep the SDK defaults as the single
  // source of truth — the server-side base is unmeasured, so guessing one
  // here would weld the guess into every call.
  const request = { region: params.region || 'cn-southwest-2' };
  if (params.agent_name) request.agent_name = String(params.agent_name);
  if (params.limit !== undefined && params.limit !== null) request.limit = Number(params.limit);
  if (params.offset !== undefined && params.offset !== null) request.offset = Number(params.offset);
  const jsonArg = JSON.stringify(request);

  const childEnv = buildChildEnv(options);
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', LIST_AGENTS_SNIPPET, jsonArg];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const failed =
        result.timedOut || result.exitCode !== 0 || detectFailure(result.stdout || '', result.stderr || '');
      let agents = null;
      if (!failed) {
        try {
          const parsed = JSON.parse(result.stdout);
          agents = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
        } catch {
          agents = null;
        }
        // Parsed output must pass the SAME redaction as the string paths —
        // an unredacted parsed object would be the one surface a future
        // credential-shaped field could ride (the object path masks by key
        // name; trap 27's parse-bypass class).
        if (agents) agents = redactSecrets(agents);
      }
      return {
        ok: !failed,
        service: 'AgentArts',
        operation: 'list-agents (SDK API; no CLI command in 0.1.7)',
        executable: candidate,
        exitCode: result.exitCode,
        failureDetected: failed,
        agents,
        count: Array.isArray(agents) ? agents.length : null,
        stdout: redactSecrets(result.stdout || ''),
        stderr: redactSecrets(result.stderr || ''),
        ...(result.timedOut ? { timedOut: true, error: `agentarts list timed out after ${timeoutMs} ms.` } : {}),
      };
    },
  });
}

// Tool surface: definitions and handlers exported so tools.mjs stays a thin
// registration site (the definitions spread into TOOL_DEFINITIONS, the
// dispatch delegates here).
export const AGENTARTS_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_plan_cli_command',
    description:
      'Classify and plan an agentarts CLI command (agentarts-sdk, Huawei Cloud AgentArts) without executing it. Returns the tier (local/readonly/approved/blocked), canonical args (per-operation non-interactive flags included: destroy/memory install/uninstall append --yes, memory delete appends --force, memory create canonicalizes to --output json so its one-time api_key is printed), warnings, and an approvalToken for approved-tier cloud writes. Plan-time rejections carry their own remediation: memory create is validated for --strategies (required server-side — the rejection lists the legal values) and a json --output (the table branch loses the one-time key).',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'agentarts arguments, excluding the agentarts executable (e.g. ["memory","list","--region","cn-southwest-2"]).',
        },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_run_readonly_command',
    description:
      'Run a read-only agentarts command (memory list/get/status, gateway get/list/get-target/list-targets) with runtime credential injection and output redaction. Exit codes are unreliable in agentarts 0.1.7 — success is decided from parsed output.',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 60000.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory (config-family commands resolve .agentarts_config.yaml from cwd).',
        },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_run_approved_command',
    description:
      'Run an approved-tier agentarts command only after the exact command has been shown and explicitly approved by the user. stdin is never written; interactive-only commands (gateway delete) are hard-stopped. memory create: the one-time data-plane api_key is captured from the raw output to a 0600 file under the devkit state root — the returned payload stays redacted and carries memoryApiKeyFile (the path, never the key).',
    inputSchema: {
      type: 'object',
      required: ['args', 'approvalToken', 'approvedByUser'],
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The exact args from the plan (including the non-interactive flags the plan added). Where the plan displays <redacted> for a secret, re-supply the REAL value — a literal <redacted> is rejected.',
        },
        approvalToken: {
          type: 'string',
          description: 'The approvalToken returned by huaweicloud_agentarts_plan_cli_command.',
        },
        approvedByUser: {
          type: 'boolean',
          description: 'Must be true only after the user explicitly approves this exact command.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Optional timeout in milliseconds. Defaults: 600000 for launch (docker build), 300000 for destroy, 900000 for the invoke family, 120000 otherwise.',
        },
        cwd: { type: 'string', description: 'Optional working directory.' },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_list_agents',
    description:
      'List AgentArts agent runtimes (read-only, no approval needed) via the pinned agentarts-sdk Python API — agentarts 0.1.7 has NO list CLI command, so this is the only in-toolkit path (degraded path: the console). Returns agents[] parsed from the SDK response. Params: region (default cn-southwest-2, the only control-plane region), agent_name (fuzzy filter), limit/offset (pagination — omit to keep the SDK defaults, the single source of truth).',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description: 'Control-plane region. Defaults to cn-southwest-2 (the only control-plane region).',
        },
        agent_name: { type: 'string', description: 'Fuzzy agent-name filter (SDK get_agents agent_name).' },
        limit: { type: 'number', description: 'Page size. Omit to use the SDK default.' },
        offset: { type: 'number', description: 'Pagination offset. Omit to use the SDK default.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 60000.' },
      },
    },
  },
];

export async function callAgentartsTool(name, rawArgs = {}) {
  switch (name) {
    case 'huaweicloud_agentarts_plan_cli_command':
      return planAgentartsCommand(rawArgs.args || []);
    case 'huaweicloud_agentarts_run_readonly_command':
      return runAgentartsReadonlyCommand(rawArgs.args || [], {
        timeoutMs: rawArgs.timeoutMs,
        cwd: rawArgs.cwd,
      });
    case 'huaweicloud_agentarts_run_approved_command':
      return runAgentartsApprovedCommand(rawArgs);
    case 'huaweicloud_agentarts_list_agents':
      return listAgentartsAgents(rawArgs, { timeoutMs: rawArgs.timeoutMs });
    default:
      throw new Error(`Unknown agentarts tool: ${name}`);
  }
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asText } from './lib/as-text.ts';
import { evaluateCommandRisk, mergeRiskDecision, type RiskDecision } from './risk-rule-engine.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dirname, '..', 'safety', 'policy.json');

// Only the pattern-array fields this module reads are modeled. Extra keys in
// policy.json are intentionally not surfaced through the type.
export interface Policy {
  secretKeyNamePatterns: string[];
  credentialFilePatterns: string[];
  blockedConfigureSubcommands: string[];
  blockedSecretOperations: string[];
  blockedSecretCliPatterns: string[];
  writeOperationPrefixes: string[];
  readOperationPrefixes: string[];
}

export interface ClassifyOptions {
  policy?: Policy;
  allowWrites?: boolean;
  allowCredentialRead?: boolean;
  rawCommand?: string;
  skipRiskRules?: boolean;
  _segmentDepth?: number;
  _narrowRouted?: boolean;
}

// An absent field normalizes to [] (older policies). A field that is present
// but not an array throws: the pre-migration module crashed on first use of a
// malformed policy, and silently emptying e.g. writeOperationPrefixes would
// reclassify write commands as safe — the enforcement layer must fail closed.
function toStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`safety policy field "${field}" must be an array of strings`);
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function loadPolicy(path: string = policyPath): Policy {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('safety policy must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  return {
    secretKeyNamePatterns: toStringArray(raw.secretKeyNamePatterns, 'secretKeyNamePatterns'),
    credentialFilePatterns: toStringArray(raw.credentialFilePatterns, 'credentialFilePatterns'),
    blockedConfigureSubcommands: toStringArray(raw.blockedConfigureSubcommands, 'blockedConfigureSubcommands'),
    blockedSecretOperations: toStringArray(raw.blockedSecretOperations, 'blockedSecretOperations'),
    blockedSecretCliPatterns: toStringArray(raw.blockedSecretCliPatterns, 'blockedSecretCliPatterns'),
    writeOperationPrefixes: toStringArray(raw.writeOperationPrefixes, 'writeOperationPrefixes'),
    readOperationPrefixes: toStringArray(raw.readOperationPrefixes, 'readOperationPrefixes'),
  };
}

const DEFAULT_POLICY = loadPolicy();

// The secret-read vocabulary for the TEXT faces (joined args, raw text,
// quote-stripped shadow) is DERIVED from policy.blockedSecretOperations —
// the same source the py hook compiles SECRET_READ_RE from — so the layers
// share one vocabulary by construction instead of by editing discipline.
// Only entries that are a prefix of another entry (ShowSecret is a stem of
// ShowSecretVersion) get boundary guards: the stem must not substring-match
// longer operations or stem-containing resource names (ShowSecretsConfig,
// showsecret-demo), while self-specific entries keep substring semantics so
// quote-mangled shadows (download'secret') stay denied in both layers.
// Empty-string entries are dropped; an empty list yields a NEVER-MATCHING
// pattern so an absent/emptied field degrades like the py layer (which
// skips the gate entirely) instead of matching everything.
export function deriveSecretOperationAlternation(ops: readonly string[]): string {
  const entries = ops.filter((op) => op !== '');
  if (entries.length === 0) return '(?!)';
  return entries
    .map((op) => {
      const l = op.toLowerCase();
      // Identity compares the ORIGINAL strings (matching the py closure)
      // so case-variant duplicate entries cannot silently change guard
      // semantics in one layer only.
      const isStem = entries.some((other) => other !== op && other.toLowerCase().startsWith(l));
      const escaped = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return isStem ? `(?<![A-Za-z0-9._/-])${escaped}(?![A-Za-z0-9._/-])` : escaped;
    })
    .join('|');
}

const SECRET_OP_ALTERNATION = deriveSecretOperationAlternation(DEFAULT_POLICY.blockedSecretOperations);
// Joined-args face: static value-shape extras plus the derived entries.
const SECRET_ARGS_RE = new RegExp(`secret[_-]?string|secret[_-]?binary|${SECRET_OP_ALTERNATION}`, 'i');
// Raw-text face: derived entries plus the static value-shape extras.
const SECRET_TEXT_RE = new RegExp(`${SECRET_OP_ALTERNATION}|secret_string|secret_binary`, 'i');
// Shadow face: derived entries only — the py layer has no secret_string
// vocabulary, so carrying the static extras here would split the layers.
const SECRET_SHADOW_RE = new RegExp(SECRET_OP_ALTERNATION, 'i');

function regexFrom(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

function isSecretKeyName(key: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata|inputvalue/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(String(key)));
}

function redactString(text: unknown): string {
  return (
    String(text)
      // Opaque blob keys (cloud-init user_data, metadata, private_key) carry
      // base64/scripts that may embed SSH keys, DB passwords, bootstrap tokens.
      // Redact the ENTIRE value of this arg — not just the first whitespace token.
      // Quoted-key variants: gateway validation errors echo arguments as JSON
      // ("adminPass":"...") and pydantic echoes them as input_value=... — the
      // unquoted key=value form alone left both shapes crossing unredacted.
      // Auth-style headers carry multi-word values ("Authorization: Bearer
      // <jwt>"): the first-token capture redacted 'Bearer' and crossed the
      // credential itself, so this family consumes to end-of-line like the
      // blob-key branch above.
      .replace(
        /(["']?(?:user[_-]?data|metadata|private[_-]?key|authorization|x[_-]?auth[_-]?token)["']?\s*[:=]\s*).*/gi,
        '$1<redacted>',
      )
      .replace(
        /(["']?(?:access[_-]?key|secret[_-]?key|security[_-]?token|token|password|passwd|admin[_-]?pass|credential|input[_-]?value)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1<redacted>',
      )
      .replace(/\b(["']?(?:AK|SK)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
  );
}

// Overload parameter names are documentation only; the implementation below
// carries the real, used parameters.
export function redactSecrets(value: string, policy?: Policy): string;
export function redactSecrets(value: unknown, policy?: Policy): unknown;
export function redactSecrets(value: unknown, policy: Policy = DEFAULT_POLICY): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, policy));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSecretKeyName(key, policy) ? '<redacted>' : redactSecrets(val, policy),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return value;
}

// The devkit's own `secret exec` wrapper: a runner (npx/pnpm/yarn/node)
// launching the bin — bare, path-qualified, with an extension
// (.js/.cjs/.mjs/.ts/.exe) or an npx version spec (huaweicloud-devkit@latest)
// — then `secret exec [flags] -- <child>`. Unwrapped so an embedded hcloud
// child keeps the classification bare hcloud would get — the wrapper must
// not launder the write gate. The scan covers EVERY token (a devkit bin
// earlier in the line that is not an exec invocation — `secret list && …` —
// only skips that position, never aborts the scan) and does not stop at a
// `--` boundary (npm's own separator legitimately precedes the bin:
// `npx -- huaweicloud-devkit …`).
function unwrapSecretExecWrapper(args: string[]): string[] | null {
  for (let i = 0; i + 2 < args.length; i++) {
    if (!matchesBinName(String(args[i]), DEVKIT_BIN_NAMES)) continue;
    // npm's own separator may sit between the bin and the subcommand
    // (`npm exec huaweicloud-devkit -- secret exec …`); skipping `--`
    // tokens here is safe — the devkit CLI itself takes no `--` before its
    // subcommand, so a literal `-- secret get` spelling is not a reveal,
    // and denying it is the safe direction anyway.
    let j = i + 1;
    while (String(args[j]) === '--') j++;
    if (String(args[j]).toLowerCase() !== 'secret' || String(args[j + 1]).toLowerCase() !== 'exec') continue;
    const dd = args.indexOf('--', j + 2);
    if (dd < 0 || dd + 1 >= args.length) continue;
    return args.slice(dd + 1);
  }
  return null;
}

// Shared bin-token normalization for the wrapper seams. A trailing
// @version spec (npx pkg@latest) is stripped — but never a path segment
// (/opt/sqc@old/bin keeps its @). Leading `$(` / `$` runs are stripped
// (substitution heads; a bare `$bin` variable is the known fail-closed
// corner — isHcloudToken has the same property). Quote/backslash/dollar
// mangling is normalized because the tokenizer keeps mid-token quoting
// while the shell still executes the canonical bin (`skill'-'quality'-'cli`).
// `<` is deliberately NOT stripped: a `<hcloud` token is a redirection, and
// matching one as "the hcloud child" manufactures a child the classifier
// then has to rescue — the segment splitter consumes live `<(` before
// tokenization, so nothing real reaches the predicate with a leading `<`.
function normalizeBinToken(token: string): string {
  return String(token)
    .toLowerCase()
    .replace(/@[^/\\]*$/, '')
    .replace(/^[$(]+/, '')
    .replace(/['"`$\\]/g, '');
}

// Bin-name matching tries BOTH the raw token (Windows `\`-qualified paths
// keep their separators — normalizing first would strip them and dead-code
// every `\\name` branch) and the normalized form (POSIX quote/escape
// mangling — `skill\-quality\-cli`).
function matchesBinName(token: string, names: readonly string[]): boolean {
  const raw = String(token)
    .toLowerCase()
    .replace(/@[^/\\]*$/, '');
  const norm = normalizeBinToken(token);
  return names.some(
    (n) =>
      raw === n ||
      raw.endsWith(`/${n}`) ||
      raw.endsWith(`\\${n}`) ||
      norm === n ||
      norm.endsWith(`/${n}`) ||
      norm.endsWith(`\\${n}`),
  );
}

const DEVKIT_BIN_NAMES = [
  'huaweicloud-devkit',
  'huaweicloud-devkit.js',
  'huaweicloud-devkit.cjs',
  'huaweicloud-devkit.mjs',
  'huaweicloud-devkit.ts',
  'huaweicloud-devkit.exe',
  'setup-cli.js',
  'setup-cli.mjs',
  'setup-cli.ts',
  'setup.cjs',
] as const;

const SKQ_BIN_NAMES = ['skill-quality-cli', 'skill-quality-cli.exe', 'skill-quality-cli.bin'] as const;

// The `skill-quality-cli run` wrapper the adopted huawei-cloud-* service
// skills teach: hcloud commands ride behind it so quality reporting can
// attribute the run. Unwrapped so the embedded hcloud child keeps the
// classification bare hcloud would get — the wrapper must not launder the
// write gate (same doctrine as the secret-exec seam). Bin spellings match
// bare, path-qualified, .exe (pip Windows shims) and .bin (the ELF tier
// the installer deploys), normalized for quote mangling. Between the bin
// and `run`, `-`-prefixed tokens (npm's `--`, the --no-auto-upgrade
// global, any flag we do not know) are skipped until the `run` token; a
// non-flag token there is a different subcommand — abort. The child
// separator decision lives INSIDE the flag walk: a bare `--` while still
// scanning flags ends the scan (everything after is the verbatim child,
// leading `--`s stripped the way argparse strips them); the first
// non-flag token ends it the same way. Known value-carrying flags
// (--skill-name/--session-id/--json) skip their value token; when that
// value token is itself an hcloud bin, the child starts AT the hcloud
// token (wrapper-ambiguous — the deny composes). When the no-separator
// walk yields a child whose head is NOT an hcloud bin but an hcloud bin
// token sits later in the tail, the flag grammar was unknown to us (an
// unrecognized value flag consumed the head) — the child starts at that
// hcloud token instead, for the same reason. The scan covers EVERY token
// (a wrapper bin earlier in the line only skips that position) — so prose
// that mentions a wrapped write, and heredoc/quoted data quoting one,
// also deny; that is the seam's inherited doctrine, deliberately.
const SKQ_VALUE_FLAGS = new Set(['--skill-name', '--session-id', '--json']);

function isHcloudBinToken(token: string): boolean {
  const t = normalizeBinToken(token);
  return t === 'hcloud' || t.endsWith('/hcloud') || t === 'hcloud.exe';
}

// A shell/eval token that actually heads a SCRIPT command (bash -c
// <script>, eval <script>) — the re-base targets for the wrapper fallbacks.
// A bare `bash deploy.sh` (no -c) is NOT a script head: re-basing to it
// would feed the script filename into operation classification.
function isScriptCommandHead(args: string[], idx: number): boolean {
  const s = String(args[idx]).toLowerCase();
  const base = basenameOf(s);
  const shellLike = SHELL_FIRST_TOKENS.has(s) || (base !== s && SHELL_FIRST_TOKENS.has(base));
  if (shellLike) {
    const flag = idx + 1 < args.length ? String(args[idx + 1]) : '';
    return /^-[a-z]*c$/i.test(flag) && idx + 2 < args.length;
  }
  if (s === 'eval' && idx + 1 < args.length) return true;
  return windowsScriptArgAt(args, idx) !== null;
}

// Where the wrapper's grammar model says the CHILD starts, judged from a
// value-slot: a token index (the grammar child head — an hcloud bin or a
// script head reached through the wrapper's own flag grammar; the re-base
// composes the deny from there), -1 (a `--` separator is still reachable —
// the separator's child is authoritative and the walk continues to the
// `--` branch), or -2 (the flag region ends at a non-child token — the
// slot re-base stands, fail closed). A script-head slot IS the child
// (bash -c <script> / eval <script>) — handled by the caller, never here.
function grammarChildAt(args: string[], from: number): number {
  let n = from;
  while (n < args.length) {
    const t = String(args[n]);
    if (t === '--') return -1;
    if (!t.startsWith('-')) break;
    if (!t.includes('=') && SKQ_VALUE_FLAGS.has(t.toLowerCase())) {
      n += 2;
      continue;
    }
    n++;
  }
  if (n >= args.length) return -1;
  const t = String(args[n]);
  if (isHcloudBinToken(t) || isScriptCommandHead(args, n)) return n;
  return -2;
}

function unwrapSkillQualityCli(args: string[]): string[] | null {
  for (let i = 0; i + 1 < args.length; i++) {
    if (!matchesBinName(args[i]!, SKQ_BIN_NAMES)) continue;
    let j = i + 1;
    while (j < args.length && String(args[j]).startsWith('-')) j++;
    if (j >= args.length) continue;
    if (normalizeBinToken(String(args[j])) !== 'run') {
      // A non-flag token before `run` is either a different subcommand or
      // an unknown value-carrying flag's VALUE occupying the position —
      // the same laundering shape the post-run fallback closes. Fail
      // closed ONLY when a real child follows the hcloud bin: a trailing
      // lone `hcloud` token is a subcommand argument, not a child.
      const hcloudBeforeRun = args.findIndex((t, idx) => idx > j && isHcloudBinToken(String(t)));
      if (hcloudBeforeRun > 0 && hcloudBeforeRun + 1 < args.length) return args.slice(hcloudBeforeRun);
      continue;
    }
    let k = j + 1;
    while (k < args.length) {
      const tok = String(args[k]);
      if (tok === '--') {
        let s = k + 1;
        while (s < args.length && String(args[s]) === '--') s++;
        if (s < args.length) return args.slice(s);
        break;
      }
      if (tok.startsWith('-')) {
        k++;
        if (!tok.includes('=') && SKQ_VALUE_FLAGS.has(tok.toLowerCase()) && k < args.length) {
          // Wrapper-ambiguous value slot — the shell cannot tell whether
          // the flag consumed the token, so the worst-case parse controls:
          // a script-head slot IS the child UNLESS the wrapper's `--`
          // separator directly follows (then the separator's child is
          // authoritative); an hcloud slot resolves through the grammar
          // model — grammar child (deny composes from there), separator
          // (authoritative — the walk continues), or slot re-base (fail
          // closed); never when the token is trailing (a value, not a
          // child).
          const slotIsHcloud = isHcloudBinToken(String(args[k]));
          const slotIsScript = isScriptCommandHead(args, k);
          if ((slotIsHcloud || slotIsScript) && k + 1 < args.length) {
            if (slotIsScript) {
              if (String(args[k + 1]) !== '--') return args.slice(k);
            } else {
              const grammarChild = grammarChildAt(args, k + 1);
              if (grammarChild === -2) return args.slice(k);
              if (grammarChild >= 0) return args.slice(grammarChild);
            }
          }
          k++;
        }
        continue;
      }
      // REMAINDER walk: the child head must be an hcloud bin for the
      // wrapper to be hcloud-bearing; anything else means unknown flag
      // grammar — fall back to the first hcloud bin with a following
      // token (a lone trailing hcloud is an argument, not a child), then
      // to the first script command head (bash -c / eval children
      // classify exactly like their `--`-separated twins), then to the
      // verbatim child.
      if (isHcloudBinToken(tok)) return args.slice(k);
      const hcloudAt = args.findIndex((t, idx) => idx > k && isHcloudBinToken(String(t)));
      if (hcloudAt > 0 && hcloudAt + 1 < args.length) return args.slice(hcloudAt);
      const scriptAt = args.findIndex((t, idx) => idx > k && isScriptCommandHead(args, idx));
      if (scriptAt > 0) return args.slice(scriptAt);
      return args.slice(k);
    }
  }
  return null;
}

// Shell and wrapper unwrapping shared by the classification path and the
// hcloud-segment pass: bash -c / sudo / the devkit secret-exec wrapper.
const SHELL_FIRST_TOKENS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'bash.exe',
  'sh.exe',
  '/bin/bash',
  '/bin/sh',
  '/bin/zsh',
  '/bin/dash',
]);

// Tokens that occupy the command position without being the command:
// wrappers and control keywords (sudo unwraps below; nohup/env/time/timeout/
// watch/nice/stdbuf/setsid/ionice prefix real invocations; do/then follow
// loop/if bodies while if/while/until/case/{ HEAD them; exec/command/eval
// dispatch the command), plus cmd.exe's launch builtins start/call (the
// unwrapped Windows payload `start /b hcloud …` re-bases onto the child),
// the PowerShell/cmd control vocabulary (see the inline block), and
// VAR=VALUE assignments (`env HW_REGION=x hcloud …`). Stripping them lets
// the hcloud-leading check see the actual command token.
const COMMAND_POSITION_PREFIXES = new Set([
  'sudo',
  'nohup',
  'env',
  'time',
  'do',
  'then',
  'elif',
  'elseif',
  'else',
  'xargs',
  'if',
  'while',
  'until',
  'exec',
  'command',
  'coproc',
  '!',
  '{',
  '(',
  'timeout',
  'watch',
  'nice',
  'stdbuf',
  'setsid',
  'ionice',
  'start',
  'call',
  // PowerShell scriptblock control grammar (try/catch/finally, begin/
  // process/end, switch/default, foreach/%, where, function/filter) and
  // cmd `if`-condition words (defined/exist/not/errorlevel): a wrapper
  // payload headed by these runs its body, so the re-base must see
  // through them. None is a plausible bare POSIX program name.
  'try',
  'catch',
  'finally',
  'begin',
  'process',
  'end',
  'switch',
  'default',
  'foreach',
  'where',
  'function',
  'filter',
  'defined',
  'exist',
  'not',
  'errorlevel',
  '%',
]);
// Value-taking single-letter flags PER PREFIX (`sudo -u root`, `nice -n 5`,
// `xargs -I {}`, `stdbuf -o0` attached). A shared set over-stripped:
// `time -p` and `command -p` take no value, so the command token itself
// was eaten.
const PREFIX_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  [
    'sudo',
    new Set([
      '-u',
      '-g',
      '-p',
      '-U',
      '-r',
      '-t',
      '-D',
      '-C',
      '--user',
      '--group',
      '--prompt',
      '--other-user',
      '--role',
      '--type',
    ]),
  ],
  ['nice', new Set(['-n', '--adjustment'])],
  ['xargs', new Set(['-I', '-d', '-E', '-S', '--replace', '--delimiter', '--max-args', '--max-chars'])],
  ['stdbuf', new Set(['-o', '-e', '-i'])],
  ['env', new Set(['-u', '--unset'])],
  ['timeout', new Set(['--signal', '-s', '-k', '--kill-after'])],
  // cmd.exe's `start` takes slash flags (`/b /wait /min …`); `/d <path>`
  // carries a value.
  ['start', new Set(['/d'])],
]);
// Leading redirection tokens (`2>/dev/null cmd`, `<in cmd`, `2>&1 cmd`)
// occupy the command position without being the command.
function isRedirectionToken(token: string): boolean {
  return /^\d*(>>|>|<|&>>|>&|<&)/.test(token);
}
// Basename of a path-qualified wrapper (`/usr/bin/time` → `time`).
function basenameOf(token: string): string {
  const t = token.replaceAll('\\', '/');
  const idx = t.lastIndexOf('/');
  return idx < 0 ? t : t.slice(idx + 1);
}

function isFlagOrDuration(token: string): boolean {
  return token.startsWith('-') || /^\d*\.?\d+[smh]?$/i.test(token);
}

// Windows script-taking wrappers (`cmd /c "hcloud …"`, `cmd /k …`,
// `powershell -Command|-c "hcloud …"`, `pwsh …`, plus .exe, path-qualified,
// `//c` (Git-Bash path-mangling), glued `/c"…"`, and quote-mangled
// spellings): like `bash -c`, the payload arrives as ONE argument and must
// be re-tokenized before classification (#731/#760 parity with main).
// Both shells accept OPTIONS before the script flag — the canonical
// PowerShell spelling is `-NoProfile -Command`, cmd takes `/d /s /v:on`
// before `/c` — so the option region is scanned without a count cap or a
// closed option set (PowerShell binds every token before -Command to an
// option; cmd skips slash switches). PowerShell ALSO accepts the command
// as the first POSITIONAL argument (`powershell hcloud ECS ListServers`
// binds -Command positionally), covered by a second pass that skips the
// KNOWN value-taking options' values — an unknown future value-option
// makes its value look positional, which matches the real shell's own
// binding. `-File`/`-EncodedCommand` are terminal (no inline command;
// encoded payloads are a documented residual). Bare `cmd` (no /c//k)
// takes no inline script — null, never a guess.
const WINDOWS_CMD_NAMES = ['cmd', 'cmd.exe'];
const WINDOWS_PS_NAMES = ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'];
const POWERSHELL_VALUE_OPTIONS = new Set([
  '-executionpolicy',
  '-outputformat',
  '-inputformat',
  '-workingdirectory',
  '-windowstyle',
  '-version',
  '-configurationname',
  '-psconsolefile',
  '-settingsfile',
  '-custompipename',
]);
const POWERSHELL_TERMINAL_OPTIONS = new Set(['-file', '-encodedcommand', '-enc']);
// `-Command` in every unambiguous abbreviation (-c, -co, … -command),
// with the payload attached via a colon OR a directly-glued quote
// (`-Command:hcloud …`, `-Command"hcloud …"`, `-c'…'` — PowerShell accepts
// parameter-glued values in all three spellings). Case-insensitive with
// the payload captured from the ORIGINAL token (service names keep case).
const POWERSHELL_COMMAND_FLAG = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?:(["':])(.*))?$/i;
// cmd's script switches tolerate `//c` (Git-Bash path conversion) and a
// glued payload (`/c"hcloud …`); case-insensitive for the same reason.
// ReactOS also honors `/r` as a script flag — included fail-closed.
const CMD_SCRIPT_FLAG = /^\/+([ckr])(.*)$/i;

function windowsScriptArgAt(args: string[], idx: number): string | null {
  const payload = windowsScriptArgAtRaw(args, idx);
  // cmd/PS glue braces to commands without whitespace (`try{hcloud …`,
  // `}finally{`); the POSIX vocabulary is word-exact, so braces are spaced
  // at the single extraction chokepoint every consumer shares — but ONLY
  // at command-grammar positions: `{` preceded by start/whitespace/
  // word-char/`)`/`}`, and `}` followed by a letter. `={`/`:{`/`[`-glued
  // and value-internal braces (`--cli-jsonInput={x:1}`) keep the token
  // whole so argv service/operation positions do not shift.
  if (payload === null) return null;
  return payload.replace(/(^|[\sA-Za-z0-9)}])\{/g, '$1 { ').replace(/\}(?=[A-Za-z])/g, '} ');
}

function windowsScriptArgAtRaw(args: string[], idx: number): string | null {
  const head = String(args[idx] ?? '');
  const isCmd = matchesBinName(head, WINDOWS_CMD_NAMES);
  const isPs = !isCmd && matchesBinName(head, WINDOWS_PS_NAMES);
  if (!isCmd && !isPs) return null;
  const payloadOf = (j: number, glued: string | null): string | null => {
    // The GLUED fragment keeps its edge-quote strip (carved from a word
    // token). The REST tokens join with plain spaces — a cmd / powershell
    // payload is a COMMAND LINE — and the joined payload's `\"` pairs
    // (span-internal escapes from the original quoting) are RESOLVED so
    // the re-tokenization regroups `\"hcloud …\"` into a proper span
    // instead of a glued `\"hcloud` word that binds bash -c to one token
    // and drops its argv.
    const strip = (s: string): string => s.replace(/^['"]|['"]$/g, '');
    const resolve = (s: string): string => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const rest = args.slice(j + 1).map(String);
    if (glued !== null) {
      const g = strip(glued);
      return resolve(rest.length ? `${g} ${rest.join(' ')}` : g);
    }
    return rest.length ? resolve(rest.join(' ')) : null;
  };
  if (isCmd) {
    for (let j = idx + 1; j < args.length; j++) {
      const tok = String(args[j]).toLowerCase();
      if (!tok.startsWith('/')) {
        // Real cmd SKIPS non-switch junk before /c|/k (Wine and ReactOS
        // both scan past anything not starting with `/`) — bailing here
        // would launder `cmd foo /c hcloud <write>`; junk is skipped.
        continue;
      }
      const m = String(args[j]).match(CMD_SCRIPT_FLAG);
      if (m) return payloadOf(j, m[2] === '' ? null : (m[2] ?? null));
    }
    return null;
  }
  // PowerShell, pass 1: the -Command flag (or a terminal option) anywhere
  // after the head — option order is free, every earlier token is an
  // option or its value. The payload may be colon- or quote-glued to the
  // flag itself.
  for (let j = idx + 1; j < args.length; j++) {
    const tok = String(args[j]).toLowerCase();
    if (POWERSHELL_TERMINAL_OPTIONS.has(tok)) return null;
    const m = String(args[j]).match(POWERSHELL_COMMAND_FLAG);
    if (m) {
      if (m[2] === undefined) return payloadOf(j, null);
      // An empty attached value (`-Command:` with nothing after the
      // colon) is the same real argv as the bare flag — PowerShell treats
      // the trailing arguments as the command — so it must not bail the
      // whole wrapper (the `-Command:""` spelling already denies).
      if (m[2] === '') return payloadOf(j, null);
      const attached = m[2].replace(/^['"]|['"]$/g, '');
      const rest = args.slice(j + 1).map(String);
      const resolve = (s: string): string => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return resolve(rest.length ? `${attached} ${rest.join(' ')}` : attached);
    }
  }
  // Pass 2: no flag — the first positional argument IS the command
  // (powershell.exe binds position 0 to -Command). Known value-taking
  // options consume their value first.
  let j = idx + 1;
  while (j < args.length) {
    const tok = String(args[j]).toLowerCase();
    if (POWERSHELL_TERMINAL_OPTIONS.has(tok)) return null;
    if (tok.startsWith('-')) {
      j++;
      if (POWERSHELL_VALUE_OPTIONS.has(tok) && j < args.length && !String(args[j]).toLowerCase().startsWith('-')) {
        j++;
      }
      continue;
    }
    return payloadOf(j - 1, null);
  }
  return null;
}

function skipPrefixArguments(prefix: string, tokens: string[]): string[] {
  const valueFlags = PREFIX_FLAGS_WITH_VALUE.get(prefix) ?? new Set<string>();
  let rest = tokens;
  while (
    rest.length > 0 &&
    (isFlagOrDuration(String(rest[0])) ||
      ((prefix === 'start' || prefix === 'call') && String(rest[0]).startsWith('/')))
  ) {
    const flag = String(rest[0]);
    rest = rest.slice(1);
    if (!flag.includes('=') && valueFlags.has(flag) && rest.length > 0) {
      rest = rest.slice(1);
    }
  }
  return rest;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

// One spelling of the hcloud bin-token predicate. The token is normalized
// first — stripping a leading `$(`/backtick/`{`/`&`/`@` (the cmd
// echo-suppression sigil) and any quote/backslash characters — because the
// tokenizer keeps mid-token quoting (`hclou'd'`, `$(hcloud`, the
// PowerShell call-operator's glued `&{hcloud`, cmd's `@hcloud`) while the
// shell still executes the canonical bin. The RAW token is checked FIRST
// (before backslash stripping) so a Windows drive-qualified bin
// (`C:\hcloud.exe`) keeps its separators — the same dual raw+normalized
// doctrine matchesBinName applies to wrapper heads.
// obsutil write subcommands (module scope — shared by the OBS
// classification and the xargs feeder pre-filter).
const OBSUTIL_WRITES = new Set([
  'mb',
  'cp',
  'mv',
  'rm',
  'delete',
  'mkdir',
  'sync',
  'restore',
  'chattri',
  'bucketpolicy',
  'lifecycle',
  // cors/website materialized as real write-capable subcommands in KooCLI
  // 7.3.12 (the pinned version): live-measured `OBS help cors|website` exits 0
  // with -method=[get,put,delete], and `-method=get` on a nonexistent bucket
  // returns an OBS-side NoSuchBucket 404 — a service-reaching command, not a
  // stub. KooCLI 7.2.x rejects both with "No such command" (exit 3), which is
  // where upstream main's #1001 "nonexistent subcommands" removal was measured;
  // keep them denied so a future three-way merge resolves by this evidence,
  // not by main's stale comment.
  'cors',
  'website',
  'sign',
  'share-add',
  'share-update',
  'share-rm',
  // KooCLI 7.3.12 added these write-capable obsutil subcommands — set/put/
  // delete via -method for bucket-tagging/object-tagging/encryption/
  // mirror-back-to-source; custom-domain writes ride on -cname/certificate
  // options instead. All must hit the write deny like their older siblings.
  'bucket-tagging',
  'object-tagging',
  'encryption',
  'custom-domain',
  'mirror-back-to-source',
  // 7.3.12's public-access-block family: the get*/read variants stay reads,
  // but put/delete are full-name writes (Set/Delete the bucket's
  // Block-Public-Access configuration — deleting it re-opens public access).
  'put-public-access-block',
  'delete-public-access-block',
  // Pre-existing on 7.2.x too but never dispositioned (7.3.12-pin sweep catch):
  // abort discards in-flight multipart uploads; archive writes log files into
  // OBS — both cloud-side writes, same class as cp/rm.
  'abort',
  'archive',
  // create-share is the live share-authorization family (issues a capability
  // token — the same privilege class as sign, which is denied); the
  // share-add/update/rm spellings above are the dead pre-rename names.
  // update is obsutil's SELF-update (mutates the installed binary — denied on
  // the same least-surprise grounds).
  'create-share',
  'update',
]);

// Peel a trailing glued redirection (with its operand) off a token:
// `hcloud>out`, `OBS>&2` — bash still runs the bin with the service.
function peelGluedRedirect(token: string): string {
  return token.replace(/>{1,2}[^>;&|]*$/, '').replace(/>&\d+$/, '');
}

function isHcloudToken(token: string): boolean {
  // Trailing shell-operator runs (`hcloud>`, `hcloud;`, `hcloud|`) and
  // glued redirect-with-operand (`hcloud>out`) attach to the bin in a
  // single token — bash still runs the bin.
  const raw = peelGluedRedirect(
    String(token)
      .toLowerCase()
      .replace(/^[$(`{&@<.]+/, '')
      .replace(/[>;&|]+$/, ''),
  );
  if (
    raw === 'hcloud' ||
    raw === 'hcloud.exe' ||
    raw.endsWith('/hcloud') ||
    raw.endsWith('\\hcloud') ||
    raw.endsWith('/hcloud.exe') ||
    raw.endsWith('\\hcloud.exe') ||
    /^[a-z]:hcloud(\.exe)?$/.test(raw)
  ) {
    return true;
  }
  // Quote-mangled Windows paths (`C:\hclou"d".exe`, the call operator's
  // `&('C:\hcloud.exe')`): strip quotes and wrapping parens but KEEP
  // backslashes before the path-suffix/drive-relative checks.
  const noQuotes = raw.replace(/['"()]/g, '');
  if (
    noQuotes !== raw &&
    (noQuotes.endsWith('\\hcloud') || noQuotes.endsWith('\\hcloud.exe') || /^[a-z]:hcloud(\.exe)?$/.test(noQuotes))
  ) {
    return true;
  }
  // Fully normalized: the PowerShell call operator on a parenthesized
  // string literal (`&('hcloud')`, `.('hcloud')`) peels its wrapping
  // punctuation to the canonical bin.
  const t = raw.replace(/['"\\`$()]/g, '');
  return t === 'hcloud' || t === 'hcloud.exe' || t.endsWith('/hcloud');
}

// Unwrap with the windows-payload context exposed: the segment scanner
// needs to know the stream passed through a cmd/powershell payload (every
// LATER hcloud occurrence in a brace-grammar payload is a live command
// site, and `}` is not a segment separator).
function unwrapWithWindowsFlag(args: string[]): { stream: string[]; windowsPayload: boolean } {
  let windowsPayload = false;
  const stream = unwrapCore(args, (entered) => {
    if (entered) windowsPayload = true;
  });
  return { stream, windowsPayload };
}

// cmd/PS payload words glue shell separators to the bin (`x&&hcloud`,
// `ListServers}catch{hcloud`): split candidate tokens on separator runs
// before the head checks, re-basing to the piece bin + the pieces and
// tokens that follow. Tokens carrying quote characters are NOT split —
// their separators are quote-protected argument VALUES
// (`--description='a;hcloud;DeleteServers'`), not live command sites.
function hcloudPieceAt(tokens: string[], i: number): string[] | null {
  const tok = String(tokens[i] ?? '');
  let stream: string[];
  if (isHcloudToken(tok)) {
    stream = tokens.slice(i).map(String);
  } else {
    if (/['"]/.test(tok)) return null;
    const pieces = tok.split(/[;&|]+/).filter(Boolean);
    const at = pieces.findIndex((p) => isHcloudToken(p));
    if (at < 0) return null;
    stream = [...pieces.slice(at).map(String), ...tokens.slice(i + 1).map(String)];
  }
  // Drop pure-closer tokens that follow the bin (`.( 'hcloud' )`
  // tokenizes the `)` standalone) — they would occupy the service slot
  // and mask the operation behind them.
  let k = 1;
  while (k < stream.length && /^[)\]}]+$/.test(String(stream[k]))) k++;
  return stream.slice(0, 1).concat(stream.slice(k));
}

function unwrapShellAndWrappers(args: string[]): string[] {
  return unwrapCore(args, null);
}

function unwrapCore(args: string[], onWindowsPayload: ((entered: boolean) => void) | null): string[] {
  let current = args;
  // Set once a Windows wrapper payload has been entered: from then on, a
  // stall at grammar the POSIX vocabulary cannot strip (cmd `if defined X
  // …`, PS `try { … } catch { … }` — `}` is not a segment separator)
  // re-bases to the first hcloud bin with a following token — the same
  // fail-closed doctrine the skill-quality-cli REMAINDER walk applies to
  // unknown flag grammar.
  let inWindowsPayload = false;
  // Depth-capped: shell wrappers do not nest arbitrarily, and a malicious
  // input cannot loop here because every branch strictly shrinks `current`.
  for (let depth = 0; depth < 10; depth++) {
    if (!current.length) return current;
    const first = String(current[0]).toLowerCase();
    const isShell = SHELL_FIRST_TOKENS.has(first);
    // `-c`, `-lc`, `-xc` … any option cluster ending in c takes the
    // script. The script argument CAME from inside a quoted span — its
    // `\"` pairs are span-internal escapes, resolved HERE (at the
    // consumption point). When the script is ITSELF a wrapper head
    // (`bash -c bash -c '…'` — the flattened join of the real
    // `bash -c "bash -c '…'"` nesting), the tail tokens are concatenated
    // and unwrapping continues: the quoted original nests, so the
    // flattened form classifies the same way (fail-closed).
    if (isShell && /^-[a-z]*c$/i.test(String(current[1] ?? '')) && current[2]) {
      const scriptTokens = splitSimpleCommand(String(current[2]).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      const scriptHead = String(scriptTokens[0] ?? '').toLowerCase();
      const headIsWrapperish =
        SHELL_FIRST_TOKENS.has(scriptHead) ||
        scriptHead === 'eval' ||
        COMMAND_POSITION_PREFIXES.has(scriptHead) ||
        windowsScriptArgAt(scriptTokens, 0) !== null ||
        isHcloudToken(String(scriptTokens[0] ?? ''));
      if (headIsWrapperish) {
        current = [...scriptTokens, ...current.slice(3).map(String)];
        continue;
      }
      current = scriptTokens;
      continue;
    }
    // eval takes the command as ONE (quoted) argument — re-tokenize it
    // like bash -c. Real eval CONCATENATES all its arguments and
    // evaluates the joined string, so the remaining arguments are always
    // part of the command (an unquoted `eval cmd /c "hcloud …"` runs the
    // write; dropping the tail would launder it).
    if (first === 'eval' && current[1]) {
      const scriptTokens = splitSimpleCommand(String(current[1]).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      current = [...scriptTokens, ...current.slice(2).map(String)];
      continue;
    }
    // bash/PS function definitions: the NAME follows the keyword before
    // the body (`function f { hcloud … }`) — strip keyword + name.
    if ((first === 'function' || first === 'filter') && current.length > 2) {
      current = current.slice(2);
      continue;
    }
    // Windows script wrappers carry the command as ONE argument too:
    // `cmd /c "hcloud …"` / `powershell -Command "hcloud …"`.
    const winScript = windowsScriptArgAt(current, 0);
    if (winScript !== null) {
      current = splitSimpleCommand(winScript);
      inWindowsPayload = true;
      onWindowsPayload?.(true);
      continue;
    }
    if (isRedirectionToken(String(current[0]))) {
      current = current.slice(1);
      continue;
    }
    if (
      COMMAND_POSITION_PREFIXES.has(first) ||
      COMMAND_POSITION_PREFIXES.has(basenameOf(String(current[0])).toLowerCase())
    ) {
      // Locator carve-out: `where hcloud`, `if exist hcloud` probe the
      // bin's PRESENCE (cmd builtins) — a bare bin with no argv is the
      // probe shape, not a command; stripping the locator would hit the
      // empty-args fail-closed and deny a read-only lookup.
      if (
        (first === 'where' || first === 'exist' || first === 'defined') &&
        current.length === 2 &&
        isHcloudToken(String(current[1] ?? ''))
      ) {
        break;
      }
      // cmd.exe's `start` consumes an optional quoted TITLE before the
      // child (`start "t" hcloud …`); quoting is lost in the token stream,
      // so when the token after start's flags is not itself a command head
      // and the one after it is, the title is skipped (fail-closed toward
      // the child interpretation).
      if (basenameOf(String(current[0])).toLowerCase() === 'start') {
        const afterFlags = skipPrefixArguments('start', current.slice(1));
        if (afterFlags.length > 1) {
          const isHeadish = (tokens: string[], at: number): boolean => {
            const tok = String(tokens[at] ?? '').toLowerCase();
            return (
              isHcloudToken(String(tokens[at] ?? '')) ||
              windowsScriptArgAt(tokens, at) !== null ||
              COMMAND_POSITION_PREFIXES.has(tok) ||
              SHELL_FIRST_TOKENS.has(tok) ||
              tok === 'eval'
            );
          };
          if (!isHeadish(afterFlags, 0) && isHeadish(afterFlags, 1)) {
            current = afterFlags.slice(1);
            continue;
          }
        }
      }
      // The (lowercased) basename resolves the prefix key for
      // skipPrefixArguments too: a path-qualified `/usr/bin/sudo -u root
      // hcloud …` (any letter case) must consult sudo's value-flag grammar,
      // not an unknown-prefix empty set.
      current = skipPrefixArguments(basenameOf(String(current[0])).toLowerCase(), current.slice(1));
      continue;
    }
    if (isEnvAssignment(first)) {
      current = current.slice(1);
      continue;
    }
    const secretExecChild = unwrapSecretExecWrapper(current);
    if (secretExecChild) {
      current = secretExecChild;
      continue;
    }
    const sqcChild = unwrapSkillQualityCli(current);
    if (sqcChild) {
      current = sqcChild;
      continue;
    }
    if (inWindowsPayload && !isHcloudToken(String(current[0] ?? ''))) {
      for (let i = 1; i < current.length; i++) {
        const pieceStream = hcloudPieceAt(current, i);
        if (pieceStream !== null && pieceStream.length > 1) {
          current = pieceStream;
          break;
        }
      }
      if (isHcloudToken(String(current[0] ?? ''))) continue;
    }
    break;
  }
  return current;
}

function stripExecutable(args: string[]): string[] {
  if (!args.length) return [];
  // Unwrap shell wrappers (bash -c / sh -c 'hcloud ...', sudo hcloud ...) so
  // wrapped write commands keep their deny classification (#650 D4-16).
  const current = unwrapShellAndWrappers(args);
  if (isHcloudToken(String(current[0] || ''))) {
    return current.slice(1);
  }
  return current;
}

function commandOperation(args: unknown): { service: string; operation: string; args: string[] } {
  const stripped = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : [])
    .map(String)
    .filter(Boolean);
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-')).map((arg) => peelGluedRedirect(arg));
  if (stripped[0]?.toLowerCase() === 'configure') {
    // nonFlags slot: a flag between `configure` and its subcommand
    // (`hcloud configure --cli-region=x show`) must not mask the
    // credential-gate operation.
    return { service: 'configure', operation: nonFlags[1] ?? nonFlags[0] ?? '', args: stripped };
  }
  return {
    service: nonFlags[0] || '',
    operation: nonFlags[1] || nonFlags[0] || '',
    args: stripped,
  };
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => regexFrom(pattern).test(value));
}

function hasWritePrefix(operation: string, policy: Policy): boolean {
  // Both the raw token and its quote-stripped shadow: a mid-token quote
  // (`Cre'ateServers`) builds the canonical argv while hiding the prefix
  // from the raw form.
  const candidates = [String(operation), stripShellQuotes(String(operation))];
  return candidates.some((normalized) =>
    policy.writeOperationPrefixes.some((prefix) => new RegExp(`(^|[A-Za-z0-9])${prefix}`, 'i').test(normalized)),
  );
}

function hasReadPrefix(operation: string, policy: Policy): boolean {
  const candidates = [String(operation), stripShellQuotes(String(operation))];
  return candidates.some((normalized) =>
    policy.readOperationPrefixes.some((prefix) => new RegExp(`^${prefix}`, 'i').test(normalized)),
  );
}

function isLocalMetadataCommand(args: string[]): boolean {
  return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}

function commandRiskText(normalizedArgs: string[], options: ClassifyOptions): string {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

function applyCommandRiskRules(base: RiskDecision, normalizedArgs: string[], options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

function applyRawCommandRiskRules(base: RiskDecision, command: string, options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}

// Split a raw shell payload into command segments with a real (minimal)
// structure model instead of a flat regex: separators count only OUTSIDE
// quotes and heredoc bodies, and a trailing backslash joins lines. This is
// what keeps prose honest in both directions — `echo "a; hcloud <write>"`
// does not split inside the quoted string (the write is not a command),
// while a heredoc body or a newline-joined script still classifies per
// command. Substitution boundaries (`$(`, `<(`, backtick, `)`) split too,
// so `cat <(hcloud …)` and `case x in a) hcloud …` reach classification.
// A word that began as a Windows drive prefix (`X:` or `X:\…`): every
// backslash inside it is a path separator, never a POSIX escape. The
// opening quote is stripped so the check works inside quoted spans.
function isWindowsPathWord(current: string): boolean {
  const lastWord = current.slice(current.lastIndexOf(' ') + 1).replace(/^['"]/, '');
  return /^[A-Za-z]:$/.test(lastWord) || /^[A-Za-z]:[\\/]/.test(lastWord);
}

export function splitShellSegments(text: string, sepsOut?: string[]): string[] {
  const separators = new Set([';', '&', '|', '\n', '\r', ')']);
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // Set when a heredoc delimiter was seen: from the NEXT newline, consume
  // the body until the delimiter line. The rest of the STARTING line stays
  // live command text (bash semantics: `cat <<EOF; cmd2` runs cmd2).
  let pendingHeredoc: string | null = null;
  let heredocDelim: string | null = null;
  let heredocLine = '';
  let i = 0;
  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < text.length) {
    const ch = text[i]!;
    if (heredocDelim !== null) {
      // Inside a heredoc body: nothing splits until the delimiter line ends.
      current += ch;
      if (ch === '\n') {
        if (heredocLine.trim() === heredocDelim) {
          heredocDelim = null;
          segments.push(current);
          sepsOut?.push('\n');
          current = '';
        }
        heredocLine = '';
      } else {
        heredocLine += ch;
      }
      i++;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === '\\') {
        // Backslash escapes the next char — BOTH chars stay in the segment
        // (the base append above already keeps the backslash), so the
        // downstream escape-aware tokenizer can regroup the span
        // (`bash -c "cmd /c \"hcloud …\""`).
        if (i + 1 < text.length) current += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '\\') {
      // Backslash escapes the next char; \<newline> is a line continuation —
      // the joined command must NOT be split. A Windows drive path
      // (`C:\Windows\…`) keeps its backslashes for the same reason as the
      // quoted branch above.
      if (i + 1 < text.length) current += (isWindowsPathWord(current) ? ch : '') + text[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('$(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '<' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('<(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('>(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '`') {
      segments.push(current);
      sepsOut?.push('`');
      current = '';
      i++;
      continue;
    }
    if (separators.has(ch)) {
      if (ch === '\n' && pendingHeredoc !== null) {
        // The heredoc body starts here.
        heredocDelim = pendingHeredoc;
        pendingHeredoc = null;
        heredocLine = '';
        current += ch;
        i++;
        continue;
      }
      segments.push(current);
      sepsOut?.push(ch);
      current = '';
      i++;
      continue;
    }
    // Heredoc start: `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`, or
    // `<< DELIM`. bash recognizes the operator only at a word boundary —
    // the preceding char must be whitespace, a separator, a quote, a
    // redirect-fd digit, or the payload start — so `1<<2` (bit shift) does
    // not open one.
    if (ch === '<' && text[i + 1] === '<') {
      const prev = i === 0 ? '' : text[i - 1]!;
      const atWordStart =
        i === 0 || /\s/.test(prev) || separators.has(prev) || prev === '"' || prev === "'" || /\d/.test(prev);
      if (atWordStart) {
        let j = i + 2;
        let sawDash = false;
        while (text[j] === '-') {
          sawDash = true;
          j++;
        }
        // bash allows whitespace between the operator and the delimiter
        // (`<< EOF`).
        while (text[j] === ' ' || text[j] === '\t') j++;
        // An optional quote pair around the delimiter.
        let delimQuote = '';
        if (text[j] === '"' || text[j] === "'") {
          delimQuote = text[j]!;
          j++;
        }
        let delim = '';
        // A backslash-escaped delimiter (`<<\EOF`) and a `$`-prefixed one
        // (`<<$EOF`, `<<${EOF}`) open heredocs too — the escaped/expanded
        // word is the delimiter bash waits for; fail-closed, the raw word
        // serves (it never matches a body line, so the remainder unions
        // into the feeder).
        if (text[j] === '\\') {
          j++;
          while (j < text.length && isWordChar(text[j]!)) {
            delim += text[j]!;
            j++;
          }
          if (!delim) delim = '\\';
        } else if (text[j] === '$') {
          delim += '$';
          j++;
          if (text[j] === '{') {
            delim += '{';
            j++;
          }
          while (j < text.length && isWordChar(text[j]!)) {
            delim += text[j]!;
            j++;
          }
          if (delim.endsWith('{')) {
            if (text[j] === '}') {
              delim += '}';
              j++;
            } else {
              delim = '';
            }
          }
        } else {
          while (j < text.length && isWordChar(text[j]!)) {
            delim += text[j]!;
            j++;
          }
          if (!delim && j < text.length && !/\s/.test(text[j]!) && text[j] !== '"' && text[j] !== "'") {
            // A punctuation-leading delimiter (`<< -EOF`, `<< .D`) —
            // bash's delimiter is the entire following word; fail-closed,
            // the raw punctuation word serves.
            while (j < text.length && !/\s/.test(text[j]!) && text[j] !== '"' && text[j] !== "'") {
              delim += text[j]!;
              j++;
            }
          }
        }
        if (!delim && (delimQuote || sawDash)) {
          // An empty quoted (`<< ""`) or dash-only (`<< -`) delimiter —
          // never matches a body line, so the remainder is body: a
          // fail-closed sentinel delimiter.
          delim = '\u0000heredoc-sentinel';
        }
        const closed = delimQuote === '' || text[j] === delimQuote;
        if (delim && closed) {
          // Render the marker (operator, dashes, quote, delimiter) and
          // align i to the scan position j — the spaced forms
          // double-consumed the last delimiter char.
          current += '<<';
          for (let k2 = i + 2; text[k2] === '-'; k2++) current += '-';
          if (delimQuote) {
            quote = delimQuote as '"' | "'";
            current += delimQuote;
          }
          current += delim;
          i = j;
          pendingHeredoc = delim;
          continue;
        }
      }
    }
    current += ch;
    i++;
  }
  segments.push(current);
  sepsOut?.push('');
  if (!sepsOut) return segments.map((segment) => segment.trim()).filter(Boolean);
  // Keep sepsOut aligned when empty segments are filtered out.
  const trimmed = segments.map((segment) => segment.trim());
  const kept: string[] = [];
  const keptSeps: string[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i]) {
      kept.push(trimmed[i]!);
      keptSeps.push(sepsOut[i] ?? '');
    }
  }
  sepsOut.length = 0;
  sepsOut.push(...keptSeps);
  return kept;
}

// Find hcloud-leading command segments: quote/heredoc-aware splitting
// (splitShellSegments), tokenization per segment, and command-position
// unwrapping before the leading-hcloud check. Two recursions keep nested
// and fed payloads classifiable: (a) a quoted `bash -c`/`eval` argument is
// itself a script — its separators are live commands, so the argument is
// re-scanned (depth-capped); (b) an `xargs hcloud …` segment draws its
// arguments from the PRECEDING piped segment, so those tokens are merged
// in as candidate operation words.
function findHcloudCommandSegments(text: unknown, depth = 0, inheritedFeeder: string[] | null = null): string[][] {
  const segmentSeps: string[] = [];
  const scannerSegments = splitShellSegments(String(text), segmentSeps);
  const out: string[][] = [];
  const scriptOf = (tokens: string[]): string | null => {
    if (!tokens.length) return null;
    const first = String(tokens[0] || '').toLowerCase();
    const base = basenameOf(String(tokens[0] || '')).toLowerCase();
    const shellLike = SHELL_FIRST_TOKENS.has(first) || (base !== first && SHELL_FIRST_TOKENS.has(base));
    // `-c`, `-lc`, `-xc` … any option cluster ending in c takes the
    // script; the script argument's `\"` pairs are span-internal escapes,
    // resolved at this consumption point. When the script word is ITSELF
    // a bin or wrapper head (`bash -c hcloud ECS …` — the flattened join
    // of the real `bash -c "hcloud ECS …"`), the tail tokens belong to
    // the same command: return them joined, or the nested scan sees a
    // bare bin and hits the empty-args guard on a legitimate read.
    const isScriptFlag = /^-[a-z]*c$/i.test(String(tokens[1] || ''));
    const resolveSpan = (s: string): string => String(s).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (shellLike && isScriptFlag && tokens[2]) {
      const script = resolveSpan(tokens[2]);
      const scriptHeadTok = splitSimpleCommand(script)[0];
      const headIsCommandish =
        isHcloudToken(String(scriptHeadTok ?? '')) ||
        SHELL_FIRST_TOKENS.has(String(scriptHeadTok ?? '').toLowerCase()) ||
        String(scriptHeadTok ?? '').toLowerCase() === 'eval' ||
        COMMAND_POSITION_PREFIXES.has(String(scriptHeadTok ?? '').toLowerCase());
      if (headIsCommandish && tokens.length > 3) {
        return [script, ...tokens.slice(3).map(String)].join(' ');
      }
      return script;
    }
    // eval evaluates the JOIN of all its arguments — the script string is
    // the whole tail, not just the first word.
    if (first === 'eval' && tokens[1]) {
      return tokens
        .slice(1)
        .map((t) => resolveSpan(t))
        .join(' ');
    }
    return windowsScriptArgAt(tokens, 0);
  };
  for (let s = 0; s < scannerSegments.length; s++) {
    const tokens = splitSimpleCommand(scannerSegments[s]!);
    // Nested scripts, BEFORE any unwrapping flattens them: a quoted
    // `bash -c`/`eval` argument is itself a command line whose separators
    // are live commands. Wrapper unwrapping runs to a FIXPOINT (an sqc
    // child that is itself a secret-exec or sqc invocation reaches its
    // innermost script too) — one level per wrapper kind would miss
    // same-wrapper compositions with compound inner scripts. The depth
    // budget is 16: adversarial nests five-plus deep genuinely execute
    // (`bash -c` × 5 around `hcloud x; hcloud <write>`), and beyond the
    // budget the unwrap path re-tokenizes WITHOUT re-splitting `;` — the
    // write launders. Bounded by input length, each level consumes a
    // wrapper token. The budget (18) sits one level past the Linux
    // executability ceiling (~17 levels before MAX_ARG_STRLEN bites);
    // larger inputs are stopped by the length cap at classification
    // entry.
    if (depth < 18) {
      const candidates: string[][] = [tokens];
      let cursor = tokens;
      for (let n = 0; n < 4; n++) {
        const next = unwrapSecretExecWrapper(cursor) ?? unwrapSkillQualityCli(cursor);
        if (!next) break;
        candidates.push(next);
        cursor = next;
      }
      // A command-position prefix in front of a shell head
      // (`sudo bash -c "echo Delete | xargs hcloud ECS"`) hides the
      // script from scriptOf's head check — probe PAST the prefixes (and
      // their value flags) so the nested segment/feeder semantics fire.
      let probe = tokens;
      for (let d = 0; d < 10; d++) {
        const probeHead = String(probe[0] ?? '').toLowerCase();
        const probeBase = basenameOf(String(probe[0] ?? '')).toLowerCase();
        const isEnvAssignmentToken = /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(probe[0] ?? ''));
        if (
          !COMMAND_POSITION_PREFIXES.has(probeHead) &&
          !COMMAND_POSITION_PREFIXES.has(probeBase) &&
          !isEnvAssignmentToken
        ) {
          break;
        }
        probe = isEnvAssignmentToken ? probe.slice(1) : skipPrefixArguments(probeBase || probeHead, probe.slice(1));
        candidates.push(probe);
      }
      for (const candidate of candidates) {
        const nested = scriptOf(candidate);
        if (nested !== null) {
          // The nested script's stdin is THIS segment's stdin: a piped
          // context feeds it, so the outer feeder threads down — an
          // xargs inside the script inherits the OUTER pipe
          // (`echo Delete | bash -c 'true; xargs hcloud ECS'`).
          const nestedFeeder = s > 0 ? splitSimpleCommand(scannerSegments[s - 1]!).slice(1) : inheritedFeeder;
          out.push(...findHcloudCommandSegments(nested, depth + 1, nestedFeeder));
        }
      }
    }
    const { stream: unwrappedRaw, windowsPayload } = unwrapWithWindowsFlag(tokens);
    // A wrapper payload headed by xargs (`cmd /c "xargs hcloud ECS"` —
    // the child inherits the pipe and appends the feeder): strip the bin
    // so the hcloud-leading check and the feeder merge both engage.
    const isXargsHead = (() => {
      const t = String(unwrappedRaw[0] ?? '').toLowerCase();
      return t === 'xargs' || basenameOf(String(unwrappedRaw[0] ?? '')).toLowerCase() === 'xargs';
    })();
    const unwrapped = isXargsHead ? unwrappedRaw.slice(1) : unwrappedRaw;
    if (!isHcloudToken(String(unwrapped[0] || ''))) continue;
    // xargs feed: the preceding segment's non-command tokens become argv
    // AFTER the segment's own arguments (xargs appends stdin to the tail).
    // xargs is detected on the PRE-unwrap segment tokens AND the
    // unwrapped stream: inside a quoted windows payload the whole
    // command is one token, and only the unwrapped head exposes the
    // `xargs` bin (`echo Delete | cmd /c "xargs hcloud ECS"` — the child
    // inherits the pipe and executes the merged write). A span token
    // whose FIRST word is xargs counts too.
    const isXargsToken = (token: unknown): boolean => {
      const t = String(token).toLowerCase();
      if (t === 'xargs' || basenameOf(String(token)).toLowerCase() === 'xargs') return true;
      if (/\s/.test(String(token))) {
        const firstWord = splitSimpleCommand(String(token))[0];
        return String(firstWord ?? '').toLowerCase() === 'xargs';
      }
      return false;
    };
    const hadXargs = tokens.some((t) => isXargsToken(t)) || unwrappedRaw.some((t) => isXargsToken(t));
    // Trailing redirection feeders: a herestring's words (`<<< Delete`)
    // and a `<`-terminated segment's NEXT segment (`< <(echo Delete)` —
    // the substitution split leaves the words in the following segment)
    // are INLINE-visible feeder content, same standard as the pipe.
    const herestringAt = tokens.findIndex((t) => /^0*<{3,}/.test(String(t)));
    // A heredoc marker (`<<EOF`, `<<-EOF`, `<< EOF`) — the body words are
    // stdin feeder content for the xargs-bearing opening segment.
    const heredocAt = tokens.findIndex((t) => /^0*<<-?(?!<)/.test(String(t)));
    const trailingRedirect = /<\s*$/.test(scannerSegments[s] ?? '') && s + 1 < scannerSegments.length;
    if (hadXargs && (s > 0 || inheritedFeeder !== null || herestringAt >= 0 || heredocAt >= 0 || trailingRedirect)) {
      // The feeder is the UNION of every visible source: the pipeline
      // WALK-BACK (through control headers, group braces, and argless
      // pass-through filters — the pipe's data reaches the xargs body
      // through them: `echo Delete | if true; then xargs hcloud ECS; fi`;
      // a `;`-separated consuming command stops the walk), the inherited
      // outer pipe (the script's stdin), herestring words, and
      // redirection-substitution words. Union is fail-closed: any
      // write-shaped word reaching the argv denies.
      const controlHeadWords = new Set([
        'if',
        'while',
        'until',
        'for',
        'case',
        'then',
        'do',
        'else',
        'elif',
        'fi',
        'done',
        'esac',
        '{',
        '}',
        '(',
        ')',
        '!',
      ]);
      const passThroughBins = new Set(['cat', 'sort', 'tee', 'head', 'tail', 'uniq', 'wc', 'tr']);
      const walkBackFeeder = (): string[] => {
        const words: string[] = [];
        let k = s - 1;
        while (k >= 0) {
          const segToks = splitSimpleCommand(scannerSegments[k]!);
          const headTok = String(segToks[0] ?? '').toLowerCase();
          const args = segToks.slice(1).map(String);
          const isCtrl = controlHeadWords.has(headTok) || (passThroughBins.has(headTok) && args.length === 0);
          const sepAfter = segmentSeps[k] ?? '';
          const sepBefore = k > 0 ? (segmentSeps[k - 1] ?? '') : '';
          // `)` (substitution/subshell body) and `>(` (process
          // substitution) flow like `|` — the substituted data reaches
          // the pipe (`cat <(echo Delete) | xargs hcloud ECS`).
          const flows = sepAfter === '|' || sepAfter === ')' || sepAfter === '>(';
          if (!isCtrl && !flows) {
            // A consuming command not pipe-connected to the xargs segment
            // (`echo Delete | true; xargs …`): no stdin flow.
            if (k === s - 1) return words;
            break;
          }
          words.push(...args);
          if (!isCtrl && sepBefore !== '|' && sepBefore !== ')' && sepBefore !== '>(') break;
          k -= 1;
        }
        return words;
      };
      // xargs splits stdin on IFS: a QUOTED feeder token carries
      // multiple words (`echo "ECS DeleteServers" | xargs hcloud` runs
      // `hcloud ECS DeleteServers`) — expand every feeder token into its
      // whitespace-separated words.
      const expandWords = (tokens: string[]): string[] =>
        tokens.flatMap((t) =>
          String(t)
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => w.replace(/^['"]|['"]$/g, '')),
        );
      let feeder = expandWords([...walkBackFeeder(), ...(inheritedFeeder ?? [])]);
      if (herestringAt >= 0 && /^0*<{3,}$/.test(String(tokens[herestringAt]))) {
        // A BARE `<<<` marker: the following tokens are the payload. A
        // GLUED marker (`<<<"OBS rm"` tokenizes as `<<<"OBS` + `rm"`) is
        // handled by the redirect-marker branch below — running both
        // would duplicate the payload words.
        feeder = [...feeder, ...expandWords(tokens.slice(herestringAt + 1).map(String))];
      }
      if (trailingRedirect) {
        feeder = [
          ...feeder,
          ...expandWords(
            splitSimpleCommand(scannerSegments[s + 1]!)
              .slice(1)
              .map(String),
          ),
        ];
      }
      // Placeholders: the literal {} / % runs AND the declared -I/--replace
      // value (any replstr spelling) — stdin tokens fill those positions.
      const replstr = (() => {
        for (let t = 0; t < tokens.length; t++) {
          const token = String(tokens[t]!);
          if (token === '-I' || token === '--replace' || token === '--delimiter') {
            const next = tokens[t + 1];
            if (next !== undefined) return String(next);
          }
          const eq = token.match(/^(?:-I|--replace(?:=)?|--delimiter=)(.+)$/);
          if (eq) return eq[1]!;
        }
        return null;
      })();
      const placeholders = new Set(
        unwrapped
          .slice(1)
          .filter((token) => /^[{}%]+$/.test(String(token)) || (replstr !== null && String(token) === replstr)),
      );
      // Redirection tokens are not argv — input (`<<<`, `<`, glued
      // `<<<Delete`), output (`>`, `>>`, `2>`, `1>`, `>&2`, `2>&1`), and
      // heredoc markers (`<<EOF`, `<< EOF`) — and the words after a
      // herestring/heredoc already joined the feeder. Keep them out of
      // the own-args or they occupy the operation slot
      // (`echo Delete | xargs hcloud ECS > /dev/null`).
      const isRedirectToken = (t: string): boolean =>
        t === '<' ||
        /^0+$/.test(t) ||
        /^0+<$/.test(t) ||
        /^(?:\d*)>+<?&?/.test(t) ||
        /^0*<{3,}/.test(t) ||
        /^0*<<-?(?!<)/.test(t);
      const redirAt = unwrapped.slice(1).findIndex((token) => isRedirectToken(String(token)));
      const ownTail = redirAt < 0 ? unwrapped.slice(1) : unwrapped.slice(1, redirAt + 1);
      // A glued herestring payload (`<<<Delete`) and a heredoc body
      // (words between the marker and the delimiter) join the feeder.
      if (redirAt >= 0) {
        const marker = String(unwrapped[redirAt + 1] ?? '');
        const restTokens = unwrapped.slice(redirAt + 2).map(String);
        if (/^0*<{3,}/.test(marker)) {
          feeder = [...feeder, ...expandWords([marker.replace(/^0*<{3,}/, ''), ...restTokens])];
        } else if (/^0*<<-?/.test(marker)) {
          // Glued delimiter (`<<EOF`): the body runs until the delimiter
          // word repeats; spaced (`<<` + delim token): skip the declared
          // delimiter token first.
          const delim = marker.replace(/^0*<<-?/, '');
          const body = delim
            ? restTokens.slice(
                0,
                restTokens.findIndex((t, i) => t === delim && i > 0),
              )
            : restTokens.slice(
                1,
                restTokens.findIndex((t, i) => t === restTokens[0] && i > 0),
              );
          feeder = [...feeder, ...(body.length ? body : restTokens)];
        }
      }
      const ownArgs = ownTail.filter((token) => !placeholders.has(token));
      out.push([String(unwrapped[0]), ...ownArgs, ...feeder]);
      // Fail-closed per-word candidates: any single feeder word that
      // lands in the operation slot as the first appended argv word
      // (xargs appends stdin in order — `echo y && xargs hcloud ECS`
      // with an outer pipe feeds Delete behind the benign y). Only
      // write-prefixed words materialize candidates — a full-candidates
      // loop re-classifies each word against the whole payload and goes
      // quadratic on large legitimate feeders.
      for (const word of feeder) {
        const w = String(word).toLowerCase();
        if (
          hasWritePrefix(String(word), DEFAULT_POLICY) ||
          OBSUTIL_WRITES.has(w) ||
          (DEFAULT_POLICY.blockedConfigureSubcommands ?? []).includes(w)
        ) {
          out.push([String(unwrapped[0]), ...ownArgs, String(word)]);
        }
      }
      continue;
    }
    out.push(unwrapped);
    // A windows payload's brace grammar makes every LATER hcloud
    // occurrence a live command site (`try { read } finally { write }` —
    // `}` is not a segment separator, so the blocks stay one segment):
    // classify each further bin + following words as its own segment,
    // including bins GLUED to separator runs (`ListServers}catch{hcloud`).
    if (windowsPayload) {
      for (let i = 1; i < unwrapped.length; i++) {
        const pieceStream = hcloudPieceAt(unwrapped, i);
        if (pieceStream !== null && pieceStream.length > 1) {
          out.push(pieceStream);
        }
      }
    }
  }
  return out;
}

export function classifyHcloudArgs(args: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : []);
  // Segment pass is UNCONDITIONAL: classifying only the leading command
  // reads the operation from line one of a multi-line script and lets a
  // write on any continuation line through. Every hcloud-leading segment
  // (split on ; && || | newline &) classifies; the most severe decision
  // wins. Prefer the RAW text for the split: tokenizing first and
  // re-joining collapses quoted command strings (`bash -c "hcloud …"` one
  // token) into a flat stream where the -c argument loses its grouping.
  if (!options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(options.rawCommand || unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      // results mirrors hcloudSegments, checked non-empty above; index 0 is defined.
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk ?? '')) ||
        results[0]!
      );
    }
    // A routed TEXT with no hcloud-leading segment is an orphan: prose
    // mentioning hcloud, a quoted package-name argument (`pip install
    // "hcloud"`), redirection remnants. The argv face's orphan
    // classification is a documented TS/py drift — text calls allow;
    // direct argv calls (tools, tests) and the segment recursion keep
    // the fallthrough classifier below.
    if (options.rawCommand !== undefined) {
      return applyCommandRiskRules(
        {
          decision: 'allow',
          risk: 'not_huaweicloud',
          reason: 'No Huawei Cloud safety rule matched.',
        },
        unwrappedTokens,
        options,
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length && options._narrowRouted !== false) {
    return {
      decision: 'deny',
      risk: 'invalid',
      reason: 'Empty hcloud command arguments are not executable.',
    };
  }

  if (isLocalMetadataCommand(normalizedArgs)) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'local_metadata',
        reason: 'KooCLI local help and version commands are read-only and do not call Huawei Cloud resource APIs.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  const serviceShadow = stripShellQuotes(service).toLowerCase();
  if (serviceShadow === 'configure') {
    const subcommand = operation.toLowerCase();
    const subcommandShadow = stripShellQuotes(operation).toLowerCase();
    if (
      (policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) ||
        policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommandShadow)) &&
      options.allowCredentialRead !== true
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Direct hcloud configure inspection may expose profile credentials. Use the redacted toolkit tools instead.',
      };
    }
  }

  if (
    policy.blockedSecretOperations.some(
      (op) =>
        op.toLowerCase() === operation.toLowerCase() || op.toLowerCase() === stripShellQuotes(operation).toLowerCase(),
    )
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (SECRET_ARGS_RE.test(joined)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'The command appears to retrieve a secret value. Use a runtime secret reference pattern instead.',
    };
  }

  const readOnly = hasReadPrefix(operation, policy);
  const executionOps =
    /(^|\.)(Invoke|SyncInvoke|AsyncInvoke|Send|Trigger|Execute|Start|Reboot|Restart|Stop|Publish|Deploy)/i;
  const isExecution = executionOps.test(operation) && !readOnly;
  const isWrite = !readOnly && hasWritePrefix(operation, policy);

  if (isExecution && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'execution',
      reason: 'Huawei Cloud execution/trigger operation blocked until approved.',
    };
  }

  if (isWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason:
        'Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }

  const obsutilWrites = OBSUTIL_WRITES;
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs';
  // Lowercase the vocab lookup (py-twin parity): the real binary rejects
  // case-variant subcommands, but the policy must not lean on that — the
  // wired Node hook faces agent-constructed text, not the binary.
  const isObsWrite = isObs && obsutilWrites.has(operation.toLowerCase());
  const isObsRead = isObs && obsutilReads.includes(operation.toLowerCase());
  if (isObsWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason: 'OBS write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }
  if (isObsRead) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'read_only',
        reason: 'OBS read-only operation.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }
  if (isObsWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'OBS write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isExecution && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'execution',
        reason: 'Huawei Cloud execution/trigger operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'Huawei Cloud write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  return applyCommandRiskRules(
    {
      decision: 'allow',
      risk: readOnly ? 'read_only' : 'unknown_read',
      reason: readOnly
        ? 'Command appears to be a read-only Huawei Cloud operation.'
        : 'Command does not match a known write or secret operation; treat output as untrusted and redact it.',
      service,
      operation,
      args: normalizedArgs,
    },
    normalizedArgs,
    options,
  );
}

function splitSimpleCommand(command: unknown): string[] {
  // Double-quoted spans honor backslash escapes (`\"` nests quotes — the
  // canonical bash way to embed a Windows wrapper, `bash -c "cmd /c
  // \"hcloud …\""`); single-quoted spans do not (POSIX: no escapes inside
  // single quotes). A single-quote span's closer is OPTIONAL — an
  // unterminated `'…` runs to the end of the string as one token
  // (mirroring the py tokenizer) so malformed-but-nested payloads keep
  // their grouping; a double-quote span REQUIRES its closer so a glued
  // Windows flag (`cmd /c"hcloud …` with the closing quote stranded on
  // the last argument) re-tokenizes per-word with the leading quote
  // stripped by the edge replace.
  return (
    String(command)
      .match(/"(?:[^"\\]|\\.)*"|'[^']*'?|\S+/g)
      ?.map((part) => part.replace(/^['"]|['"]$/g, '')) || []
  );
}

// Quote/backslash-stripped shadow of a command text for PRESENCE gates: an
// agent can quote any token (`secret 'get'`, `bash -c "hcloud ..."`, g\et)
// so the raw-text regexes miss it while the shell still executes the
// canonical argv. Tokenizing (splitSimpleCommand) stays authoritative for
// classification; this only widens detection.
function stripShellQuotes(text: string): string {
  // Also strips `$` and backticks: bash's ANSI-C ($'get') and locale
  // ($"get") quoting, and command substitution, produce the canonical argv
  // while leaving those characters behind. None of the canonical tokens
  // (huaweicloud-devkit, secret, get, hcloud, …) contain them, so the shadow
  // of `sec$'r'et` collapses to `secret`. Variable indirection ($S, ${X:-…})
  // remains a documented residual — a text-presence gate cannot see through
  // expansion.
  return text.replace(/['"\\$`]/g, '');
}

// Credential-file path gate for non-Bash faces: the MCP `secret_set`
// channel=file reads a path directly, with no hook between the request and
// the read — the Bash-face credentialFilePatterns deny must apply there
// too, or the tool launders a hook-denied credential file into the vault.
// Tests the raw path AND its quote-stripped shadow (same evasion class as
// the text gate).
function normalizePathText(value: string): string {
  return value.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
}

function credentialFileCandidates(text: string): string[] {
  const shadow = stripShellQuotes(text);
  return [text, shadow, normalizePathText(text), normalizePathText(shadow)];
}

export function isCredentialFilePath(path: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const value = asText(path || '');
  if (!value) return false;
  return credentialFileCandidates(value).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns));
}

export function classifyTextCommand(command: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const text = asText(command || '');
  const shadowText = stripShellQuotes(text);

  // Length cap: a routed payload past 256 KiB cannot execute through any
  // wrapper chain (MAX_ARG_STRLEN), and classifying pathological nests
  // at that size costs minutes — a hook DoS. Denied fail-closed instead.
  if (text.length > 262_144) {
    if (
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(shadowText) ||
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(text)
    ) {
      return {
        decision: 'deny',
        risk: 'invalid',
        reason: 'Command payload too large to classify safely; denied fail-closed.',
      };
    }
  }

  // Raw, shadow, and path-normalized forms (shared with the MCP file gate):
  // a quote pair inside the path (`~/.config/huawei'cloud/secrets'/.master-
  // key`) or a redundant `//`/`/./` segment defeats the contiguous-substring
  // patterns while the shell reads the canonical path — the vault tree and
  // keyfile are the most sensitive at-rest data this gate protects.
  if (credentialFileCandidates(text).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns))) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason:
        'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
    };
  }

  // The vault CLI's own reveal surface: `secret get` prints a stored secret
  // to stdout, which is the agent context when run through the Bash tool.
  // `secret exec` (values reach only the child env) stays allowed. Matched
  // against the quote-stripped shadow so quoted subcommand spellings
  // (`secret 'get'`) do not slip past.
  if (matchesAny(shadowText, policy.blockedSecretCliPatterns)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead: npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command> — a child you trust not to print its own environment, since its stdout is this conversation. Or use secret get --file from your own terminal.',
    };
  }

  // Order-independent reveal pair: `echo secret get <ref> --stdout | xargs
  // npx huaweicloud-devkit` reorders the argv through xargs while every
  // word is literal in the text — the patterns above assume bin-before-
  // subcommand order. Any payload carrying BOTH a devkit bin and a
  // `secret get` pair is a reveal regardless of order.
  if (
    /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)/i.test(shadowText) &&
    /(?:^|\s)secret\s+get\b/i.test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead (npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command>), or use secret get --file from your own terminal.',
    };
  }

  // Obfuscated cloud-command invocation: ANSI-C escapes (`$'\x67et'`,
  // `$'\x68'uaweicloud-devkit` build argv the quote-stripping shadow cannot
  // reconstruct — the letters come from the escape, not the text) and
  // command substitution (`$(echo secret)`, a backtick form) hide tokens
  // from every presence pattern. Canonical devkit and hcloud commands never
  // contain `$'`, `$"`, `$(`, or a backtick, so a cloud-command-bearing
  // payload carrying one is denied as obfuscated rather than parsed.
  if (
    (/(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)|(^|[^a-z0-9.-])hcloud(\.exe)?\s/i.test(
      shadowText,
    ) ||
      /secret:\/\//i.test(shadowText)) &&
    /\$['"]|\$\(|`/.test(text)
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'An obfuscated cloud CLI invocation (shell expansion inside the command) is blocked. Write the command in plain form; secret refs and subcommands must be literal.',
    };
  }

  // The env-dump family: trailing boundary so `environment.md` /
  // `env_setup.py` do not match; the HW_ token is SUFFIX-scoped to the
  // documented credential names so `env HW_REGION=x hcloud …` (a region
  // assignment, not a credential) stays legitimate; HCLOUD_ underscored so
  // the KooCLI bin name does not false-match; HUAWEICLOUD excludes the
  // `-devkit` suffix so the devkit bin name does not feed the family token;
  // `export -p` and `declare`/`typeset` are dump forms of the same class.
  const CRED_ENV_NAMES =
    '(?:HUAWEICLOUD(?!-devkit)|HWC_|HCLOUD_|OS_|HW_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY))';
  if (
    /(^|\s)(env|printenv|export\s+-p|declare|typeset|set|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)(?![A-Za-z0-9_-])/i.test(
      shadowText,
    ) &&
    new RegExp(CRED_ENV_NAMES, 'i').test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping cloud credential environment variables is blocked.',
    };
  }

  // Argument-less full-dump forms — at COMMAND POSITION (start of the
  // payload or after a separator), so `make env` / `rg env` stay legitimate:
  // env/printenv/export/declare/typeset take flags; bare `set` dumps, but
  // `set -e`/`set -o pipefail` set shell options and dump nothing, so only
  // the flagless form denies. A following pipe or redirect means the dump
  // leaves the process either way.
  if (
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:--?[A-Za-z0-9-]+(?:=[^ ]*)?|-u\s+\S+))*(\s*[|>].*)?\s*$/i.test(
      shadowText,
    ) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*set\s*$/i.test(shadowText) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|set)(?![A-Za-z0-9_-])\s*(?:\||>)/i.test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping the full process environment is blocked (it includes cloud credential variables).',
    };
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
  // HUAWEICLOUD_SECRET_ACCESS_KEY spelling (#770), and `echo $HW_SECRET_KEY` /
  // `printenv HW_ACCESS_KEY`
  // previously fell through to allow (#650 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  // The $-expansion alternative stays on RAW text with its lookbehind: a
  // single-quoted '$HW_*' is a literal the shell never expands, so the
  // exemption is deliberate. The printenv alternative is a command-name
  // gate, so it runs on the shadow — quoting a command name does not stop
  // execution — and matches the credential name at ANY argument position.
  // Single-quoted spans are removed before the expansion test: the shell
  // never expands inside them, but a CLOSING quote before an unquoted $HW_
  // (`echo 'a'$HW_SECRET_KEY`) still expands — a char-level lookbehind
  // wrongly exempted that.
  const unSingleQuoted = text.replace(/'[^']*'/g, '');
  if (
    /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      unSingleQuoted,
    ) ||
    /(?:^|\s)printenv\s+.*(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      shadowText,
    )
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Printing cloud credential environment variables is blocked.',
    };
  }

  // Secret-retrieval vocabulary on the raw text AND the quote-stripped
  // shadow — the py hook searches both (a quote-mangled `show'secret'`
  // token is still a secret read), so the layers must agree. This check
  // runs BEFORE the hcloud routing return so a compound payload with
  // mangled vocabulary in a non-hcloud trailing segment (py's whole-payload
  // shadow) cannot slip past the TS face.
  if (SECRET_TEXT_RE.test(text) || SECRET_SHADOW_RE.test(shadowText)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
  }

  // Routing on the shadow with a boundary class that admits `/`, `(`, and
  // backtick before the bin: path-qualified (`/usr/bin/hcloud`) and
  // substituted (`$(hcloud …)`) invocations must reach classification, not
  // just whitespace-preceded bare names. The bin's TAIL accepts closers
  // (`&('hcloud')`, `(hcloud)`) as well as whitespace. The RAW text is
  // tested too: the shadow strips quotes and backslashes, which GLUES the
  // bin into the preceding word (`cmd /c"hcloud …`, `C:\hcloud.exe …`)
  // and defeats the boundary class there, while the raw text still
  // carries the boundary character itself. A BROAD tail (also `;`, `&`,
  // `|`, `>`, and end-of-string) routes `… | xargs hcloud;` /
  // `xargs hcloud>` — py's per-segment gate denies those; the empty-args
  // fail-closed stays gated on the NARROW tail so the pinned bare
  // `hcloud` / `sudo hcloud` allows survive.
  const narrowRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(text);
  const broadRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|>]|$)/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|>]|$)/i.test(text);
  if (broadRouted) {
    return classifyHcloudArgs(splitSimpleCommand(text), {
      ...options,
      rawCommand: text,
      _narrowRouted: narrowRouted,
    });
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: 'not_huaweicloud',
      reason: 'No Huawei Cloud safety rule matched.',
    },
    text,
    options,
  );
}

export function assertAllowed(result: RiskDecision): RiskDecision {
  if (result.decision === 'deny') {
    // Fresh Error we immediately augment; the cast names the shape we attach.
    const error = new Error(result.reason) as Error & { policy: RiskDecision };
    error.policy = result;
    throw error;
  }
  return result;
}

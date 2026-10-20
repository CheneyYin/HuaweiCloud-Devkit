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
  return s === 'eval' && idx + 1 < args.length;
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
// dispatch the command), plus VAR=VALUE assignments (`env HW_REGION=x
// hcloud …`). Stripping them lets the hcloud-leading check see the actual
// command token.
const COMMAND_POSITION_PREFIXES = new Set([
  'sudo',
  'nohup',
  'env',
  'time',
  'do',
  'then',
  'elif',
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

function skipPrefixArguments(prefix: string, tokens: string[]): string[] {
  const valueFlags = PREFIX_FLAGS_WITH_VALUE.get(prefix) ?? new Set<string>();
  let rest = tokens;
  while (rest.length > 0 && isFlagOrDuration(String(rest[0]))) {
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
// first — stripping a leading `$(`/backtick and any quote/backslash
// characters — because the tokenizer keeps mid-token quoting (`hclou'd'`,
// `$(hcloud`) while the shell still executes the canonical bin.
function isHcloudToken(token: string): boolean {
  const t = token
    .toLowerCase()
    .replace(/^[$(`]+/, '')
    .replace(/['"\\`$]/g, '');
  return t === 'hcloud' || t.endsWith('/hcloud') || t.endsWith('\\hcloud') || t === 'hcloud.exe';
}

function unwrapShellAndWrappers(args: string[]): string[] {
  let current = args;
  // Depth-capped: shell wrappers do not nest arbitrarily, and a malicious
  // input cannot loop here because every branch strictly shrinks `current`.
  for (let depth = 0; depth < 10; depth++) {
    if (!current.length) return current;
    const first = String(current[0]).toLowerCase();
    const isShell = SHELL_FIRST_TOKENS.has(first);
    if (isShell && String(current[1]).toLowerCase() === '-c' && current[2]) {
      current = splitSimpleCommand(current[2]);
      continue;
    }
    // eval takes the command as ONE (quoted) argument — re-tokenize it like
    // bash -c.
    if (first === 'eval' && current[1]) {
      current = splitSimpleCommand(current[1]);
      continue;
    }
    if (isRedirectionToken(String(current[0]))) {
      current = current.slice(1);
      continue;
    }
    if (COMMAND_POSITION_PREFIXES.has(first) || COMMAND_POSITION_PREFIXES.has(basenameOf(String(current[0])))) {
      current = skipPrefixArguments(first, current.slice(1));
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
  if (stripped[0]?.toLowerCase() === 'configure') {
    return { service: 'configure', operation: stripped[1] || '', args: stripped };
  }
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-'));
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
export function splitShellSegments(text: string): string[] {
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
      // the joined command must NOT be split.
      if (i + 1 < text.length) current += text[i + 1]!;
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
      current = '';
      i += 2;
      continue;
    }
    if (ch === '<' && text[i + 1] === '(') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (ch === '`') {
      segments.push(current);
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
        while (text[j] === '-') j++;
        // An optional quote pair around the delimiter.
        let delimQuote = '';
        if (text[j] === '"' || text[j] === "'") {
          delimQuote = text[j]!;
          j++;
        }
        let delim = '';
        while (j < text.length && isWordChar(text[j]!)) {
          delim += text[j]!;
          j++;
        }
        const closed = delimQuote === '' || text[j] === delimQuote;
        if (delim && closed) {
          current += '<<';
          i += 2;
          while (text[i] === '-') {
            current += '-';
            i++;
          }
          if (delimQuote) {
            quote = delimQuote as '"' | "'";
            current += delimQuote;
            i++;
          }
          current += delim;
          i += delim.length;
          pendingHeredoc = delim;
          continue;
        }
      }
    }
    current += ch;
    i++;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

// Find hcloud-leading command segments: quote/heredoc-aware splitting
// (splitShellSegments), tokenization per segment, and command-position
// unwrapping before the leading-hcloud check. Two recursions keep nested
// and fed payloads classifiable: (a) a quoted `bash -c`/`eval` argument is
// itself a script — its separators are live commands, so the argument is
// re-scanned (depth-capped); (b) an `xargs hcloud …` segment draws its
// arguments from the PRECEDING piped segment, so those tokens are merged
// in as candidate operation words.
function findHcloudCommandSegments(text: unknown, depth = 0): string[][] {
  const scannerSegments = splitShellSegments(String(text));
  const out: string[][] = [];
  const scriptOf = (tokens: string[]): string | null => {
    if (!tokens.length) return null;
    const first = String(tokens[0] || '').toLowerCase();
    const base = basenameOf(String(tokens[0] || '')).toLowerCase();
    const shellLike = SHELL_FIRST_TOKENS.has(first) || (base !== first && SHELL_FIRST_TOKENS.has(base));
    // `-c`, `-lc`, `-xc` … any option cluster ending in c takes the script.
    const isScriptFlag = /^-[a-z]*c$/i.test(String(tokens[1] || ''));
    if (shellLike && isScriptFlag && tokens[2]) return String(tokens[2]);
    if (first === 'eval' && tokens[1]) return String(tokens[1]);
    return null;
  };
  for (let s = 0; s < scannerSegments.length; s++) {
    const tokens = splitSimpleCommand(scannerSegments[s]!);
    // Nested scripts, BEFORE any unwrapping flattens them: a quoted
    // `bash -c`/`eval` argument is itself a command line whose separators
    // are live commands. Wrapper unwrapping runs to a FIXPOINT (an sqc
    // child that is itself a secret-exec or sqc invocation reaches its
    // innermost script too) — one level per wrapper kind would miss
    // same-wrapper compositions with compound inner scripts.
    if (depth < 4) {
      const candidates: string[][] = [tokens];
      let cursor = tokens;
      for (let n = 0; n < 4; n++) {
        const next = unwrapSecretExecWrapper(cursor) ?? unwrapSkillQualityCli(cursor);
        if (!next) break;
        candidates.push(next);
        cursor = next;
      }
      for (const candidate of candidates) {
        const nested = scriptOf(candidate);
        if (nested !== null) {
          out.push(...findHcloudCommandSegments(nested, depth + 1));
        }
      }
    }
    const unwrapped = unwrapShellAndWrappers(tokens);
    if (!isHcloudToken(String(unwrapped[0] || ''))) continue;
    // xargs feed: the preceding segment's non-command tokens become argv
    // AFTER the segment's own arguments (xargs appends stdin to the tail).
    const hadXargs = tokens.some(
      (token) => String(token).toLowerCase() === 'xargs' || basenameOf(String(token)).toLowerCase() === 'xargs',
    );
    if (hadXargs && s > 0) {
      const feeder = splitSimpleCommand(scannerSegments[s - 1]!).slice(1);
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
      const ownArgs = unwrapped.slice(1).filter((token) => !placeholders.has(token));
      out.push([String(unwrapped[0]), ...ownArgs, ...feeder]);
      continue;
    }
    out.push(unwrapped);
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
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length) {
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

  const obsutilWrites = [
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
    'cors',
    'website',
    'sign',
    'share-add',
    'share-update',
    'share-rm',
  ];
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs';
  const isObsWrite = isObs && obsutilWrites.includes(operation);
  const isObsRead = isObs && obsutilReads.includes(operation);
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
  return (
    String(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
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
  // just whitespace-preceded bare names.
  if (/(^|[^a-z0-9.-])hcloud(\.exe)?\s+/i.test(shadowText)) {
    return classifyHcloudArgs(splitSimpleCommand(text), { ...options, rawCommand: text });
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

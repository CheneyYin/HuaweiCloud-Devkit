import { isScriptCommandHead } from './script-stream.ts';
import { isHcloudBinToken, matchesBinName, normalizeBinToken } from './tokens.ts';

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

// The first hcloud bin token after a position that actually has a
// following token (a lone trailing hcloud is an argument, not a child) —
// the shared re-base finder for the pre-run and REMAINDER fallbacks.
function hcloudBinWithTail(args: string[], after: number): number {
  const at = args.findIndex((t, idx) => idx > after && isHcloudBinToken(String(t)));
  return at > 0 && at + 1 < args.length ? at : -1;
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

// Wrapper-ambiguous value slot — the shell cannot tell whether the flag
// consumed the token, so the worst-case parse controls: a script-head slot
// IS the child UNLESS the wrapper's `--` separator directly follows (then
// the separator's child is authoritative); an hcloud slot resolves through
// the grammar model — grammar child (deny composes from there), separator
// (authoritative — the walk continues), or slot re-base (fail closed);
// never when the token is trailing (a value, not a child). Null: no child
// decision, the flag walk continues past the value.
function valueSlotChildAt(args: string[], k: number): string[] | null {
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
  return null;
}

// REMAINDER walk: the child head must be an hcloud bin for the wrapper to
// be hcloud-bearing; anything else means unknown flag grammar — fall back
// to the first hcloud bin with a following token, then to the first script
// command head (bash -c / eval children classify exactly like their
// `--`-separated twins), then to the verbatim child.
function remainderChildAt(args: string[], k: number): string[] {
  if (isHcloudBinToken(String(args[k]))) return args.slice(k);
  const hcloudAt = hcloudBinWithTail(args, k);
  if (hcloudAt >= 0) return args.slice(hcloudAt);
  const scriptAt = args.findIndex((t, idx) => idx > k && isScriptCommandHead(args, idx));
  if (scriptAt > 0) return args.slice(scriptAt);
  return args.slice(k);
}

export function unwrapSkillQualityCli(args: string[]): string[] | null {
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
      const hcloudBeforeRun = hcloudBinWithTail(args, j);
      if (hcloudBeforeRun >= 0) return args.slice(hcloudBeforeRun);
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
          const slot = valueSlotChildAt(args, k);
          if (slot !== null) return slot;
          k++;
        }
        continue;
      }
      return remainderChildAt(args, k);
    }
  }
  return null;
}

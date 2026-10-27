// Command-head recognition for the unwrap engine: which heads carry a
// script argument (bash -c, eval), how that argument flattens back into a
// token stream, and where a head-shaped token actually starts a child
// (cmd.exe `start`'s optional title). The engine in unwrap.ts dispatches
// onto these; the wrappers consult them for their fallbacks.

import { splitSimpleCommand } from './shell-text.ts';
import { basenameOf, COMMAND_POSITION_PREFIXES, isHcloudToken, SHELL_FIRST_TOKENS } from './tokens.ts';
import { windowsScriptArgAt } from './windows.ts';

// A shell/eval token that actually heads a SCRIPT command (bash -c
// <script>, eval <script>) — the re-base targets for the wrapper fallbacks.
// A bare `bash deploy.sh` (no -c) is NOT a script head: re-basing to it
// would feed the script filename into operation classification.
export function isScriptCommandHead(args: string[], idx: number): boolean {
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

// The script argument of a `bash -c` head, re-tokenized. The script CAME
// from inside a quoted span — its `\"` pairs are span-internal escapes,
// resolved HERE (at the consumption point). When the script is ITSELF a
// wrapper head (`bash -c bash -c '…'` — the flattened join of the real
// `bash -c "bash -c '…'"` nesting), the tail tokens are concatenated and
// unwrapping continues: the quoted original nests, so the flattened form
// classifies the same way (fail-closed).
export function shellScriptStream(current: string[]): string[] {
  const scriptTokens = splitSimpleCommand(String(current[2]).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  const scriptHead = String(scriptTokens[0] ?? '').toLowerCase();
  const headIsWrapperish =
    SHELL_FIRST_TOKENS.has(scriptHead) ||
    scriptHead === 'eval' ||
    COMMAND_POSITION_PREFIXES.has(scriptHead) ||
    windowsScriptArgAt(scriptTokens, 0) !== null ||
    isHcloudToken(String(scriptTokens[0] ?? ''));
  if (headIsWrapperish) {
    return [...scriptTokens, ...current.slice(3).map(String)];
  }
  return scriptTokens;
}

// eval takes the command as ONE (quoted) argument — re-tokenize it like
// bash -c. Real eval CONCATENATES all its arguments and evaluates the
// joined string, so the remaining arguments are always part of the command
// (an unquoted `eval cmd /c "hcloud …"` runs the write; dropping the tail
// would launder it).
export function evalScriptStream(current: string[]): string[] {
  const scriptTokens = splitSimpleCommand(String(current[1]).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return [...scriptTokens, ...current.slice(2).map(String)];
}

export function segmentScriptOf(tokens: string[]): string | null {
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
}

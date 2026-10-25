// Windows payload re-basing for the unwrap engine and the segment
// scanner: splitting cmd/PS payload words that glue shell separators to
// the bin, and skipping cmd.exe `start`'s optional quoted title. The
// payload extraction itself lives in windows.ts.

import { COMMAND_POSITION_PREFIXES, isHcloudToken, SHELL_FIRST_TOKENS, skipPrefixArguments } from './tokens.ts';
import { windowsScriptArgAt } from './windows.ts';

// cmd/PS payload words glue shell separators to the bin (`x&&hcloud`,
// `ListServers}catch{hcloud`): split candidate tokens on separator runs
// before the head checks, re-basing to the piece bin + the pieces and
// tokens that follow. Tokens carrying quote characters are NOT split —
// their separators are quote-protected argument VALUES
// (`--description='a;hcloud;DeleteServers'`), not live command sites.
export function hcloudPieceAt(tokens: string[], i: number): string[] | null {
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

// cmd.exe's `start` consumes an optional quoted TITLE before the child
// (`start "t" hcloud …`); quoting is lost in the token stream, so when the
// token after start's flags is not itself a command head and the one after
// it is, the title is skipped (fail-closed toward the child interpretation).
// Null: no title to skip — the caller falls through to prefix stripping.
export function startTitleRebase(current: string[]): string[] | null {
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
    if (!isHeadish(afterFlags, 0) && isHeadish(afterFlags, 1)) return afterFlags.slice(1);
  }
  return null;
}

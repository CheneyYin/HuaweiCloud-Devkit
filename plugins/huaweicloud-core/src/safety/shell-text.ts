// The shell TEXT structure model: how a raw payload splits into command
// segments (separators, quotes, heredocs) and how a single command
// tokenizes. Every consumer in the safety family re-uses these so the
// text model has one spelling.

import { scanHeredocStart } from './heredoc.ts';

// A word that began as a Windows drive prefix (`X:` or `X:\…`): every
// backslash inside it is a path separator, never a POSIX escape. The
// opening quote is stripped so the check works inside quoted spans.
function isWindowsPathWord(current: string): boolean {
  const lastWord = current.slice(current.lastIndexOf(' ') + 1).replace(/^['"]/, '');
  return /^[A-Za-z]:$/.test(lastWord) || /^[A-Za-z]:[\\/]/.test(lastWord);
}

// Split a raw shell payload into command segments with a real (minimal)
// structure model instead of a flat regex: separators count only OUTSIDE
// quotes and heredoc bodies, and a trailing backslash joins lines. This is
// what keeps prose honest in both directions — `echo "a; hcloud <write>"`
// does not split inside the quoted string (the write is not a command),
// while a heredoc body or a newline-joined script still classifies per
// command. Substitution boundaries (`$(`, `<(`, backtick, `)`) split too,
// so `cat <(hcloud …)` and `case x in a) hcloud …` reach classification.
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
    if (ch === '<' && text[i + 1] === '<') {
      const start = scanHeredocStart(text, i, separators);
      if (start !== null) {
        // Render the marker (operator, dashes, quote, delimiter) and
        // align i to the scan position — the spaced forms
        // double-consumed the last delimiter char.
        current += '<<';
        for (let k2 = i + 2; text[k2] === '-'; k2++) current += '-';
        if (start.delimQuote) {
          quote = start.delimQuote as '"' | "'";
          current += start.delimQuote;
        }
        current += start.delim;
        i = start.next;
        pendingHeredoc = start.delim;
        continue;
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

export function splitSimpleCommand(command: unknown): string[] {
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
export function stripShellQuotes(text: string): string {
  // Also strips `$` and backticks: bash's ANSI-C ($'get') and locale
  // ($"get") quoting, and command substitution, produce the canonical argv
  // while leaving those characters behind. None of the canonical tokens
  // (huaweicloud-devkit, secret, get, hcloud, …) contain them, so the shadow
  // of `sec$'r'et` collapses to `secret`. Variable indirection ($S, ${X:-…})
  // remains a documented residual — a text-presence gate cannot see through
  // expansion.
  return text.replace(/['"\\$`]/g, '');
}

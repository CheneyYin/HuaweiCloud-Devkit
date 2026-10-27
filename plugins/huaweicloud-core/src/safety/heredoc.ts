// The heredoc marker scanner for the shell text model: decides whether a
// `<<` token at a position opens a heredoc and extracts the delimiter bash
// will wait for. Split from shell-text.ts so the segment loop and the
// marker grammar stay independently readable; pure leaf, no imports.

const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

// A scanned heredoc marker: the delimiter bash will wait for, the quote it
// was wrapped in (empty when bare — also the segment loop's quote-opening
// signal), and the scan position the loop must align i to.
interface HeredocStart {
  delim: string;
  delimQuote: string;
  next: number;
}

// Heredoc start scan: `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`, or
// `<< DELIM`. bash recognizes the operator only at a word boundary — the
// preceding char must be whitespace, a separator, a quote, a redirect-fd
// digit, or the payload start — so `1<<2` (bit shift) does not open one.
// Returns null when the token at i is not a heredoc start (no boundary, no
// delimiter, or an unclosed wrapping quote); the caller then treats the
// `<` as an ordinary character, exactly like the inlined branch did.
export function scanHeredocStart(text: string, i: number, separators: Set<string>): HeredocStart | null {
  const prev = i === 0 ? '' : text[i - 1]!;
  const atWordStart =
    i === 0 || /\s/.test(prev) || separators.has(prev) || prev === '"' || prev === "'" || /\d/.test(prev);
  if (!atWordStart) return null;
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
  if (delim && closed) return { delim, delimQuote, next: j };
  return null;
}

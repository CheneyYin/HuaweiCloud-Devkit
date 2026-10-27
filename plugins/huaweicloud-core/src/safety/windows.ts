import { matchesBinName } from './tokens.ts';

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

export function windowsScriptArgAt(args: string[], idx: number): string | null {
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

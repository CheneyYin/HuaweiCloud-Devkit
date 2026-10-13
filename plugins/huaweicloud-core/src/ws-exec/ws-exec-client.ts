import { randomBytes } from 'node:crypto';

// Shared exec-session helpers for the hwlink clients. The plain-WebSocket
// shell session this file once carried (WebSocketShellSession,
// connectShellSession, executeCommand) had zero callers after hwlink
// replaced it in production; only the helpers it donated survived.

const DEFAULT_TIMEOUT_MS = 30000;

interface Markers {
  nonce: string;
  readyPrefix: string;
  donePrefix: string;
  readySuffix: string;
  doneSuffix: string;
  readyMarker: string;
  doneMarker: string;
}

interface CleanCommandOutputOptions {
  inputEchoed: boolean;
  command: string;
  doneCommand: string;
}

class WebSocketExecError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WebSocketExecError';
    this.exitCode = exitCode;
    Object.assign(this, details);
  }
}

function stripEchoedLine(text: string, line: string, options: { allowAttached?: boolean } = {}): string {
  if (text.startsWith(line)) {
    text = text.slice(line.length);
    text = text.replace(/^\r?\n/, '');
    if (!options.allowAttached) return text;
  }

  for (const nl of ['\r\n', '\n']) {
    const idx = text.indexOf(nl + line);
    if (idx !== -1) {
      const before = text.slice(0, idx + nl.length);
      const after = text.slice(idx + nl.length + line.length);
      text = before + after.replace(/^\r?\n/, '');
      if (!options.allowAttached) return text;
      break;
    }
  }

  if (options.allowAttached) {
    for (let trail = 2; trail >= 0; trail--) {
      for (const nl of ['\r\n', '\n']) {
        const suffix = nl.repeat(trail);
        if (text.endsWith(line + suffix)) {
          return text.slice(0, text.length - line.length - suffix.length);
        }
      }
    }
  }

  return text;
}

function buildMarkers(nonce: string = randomBytes(8).toString('hex')): Markers {
  const readyPrefix = '__WS_EXEC_READY_';
  const donePrefix = '__WS_EXEC_DONE_';
  const readySuffix = `${nonce}__`;
  const doneSuffix = `${nonce}__:`;
  const readyMarker = `${readyPrefix}${readySuffix}`;
  const doneMarker = `${donePrefix}${doneSuffix}`;

  return {
    nonce,
    readyPrefix,
    donePrefix,
    readySuffix,
    doneSuffix,
    readyMarker,
    doneMarker,
  };
}

function buildShellCommands(markers: Markers): { readyCommand: string; doneCommand: string } {
  return {
    readyCommand: `stty -echo 2>/dev/null; export PS1= PS2= PROMPT_COMMAND=; printf '\\n%s%s\\n' '${markers.readyPrefix}' '${markers.readySuffix}'`,
    doneCommand: `__ws_exec_rc=$?; printf '\\n%s%s%d\\n' '${markers.donePrefix}' '${markers.doneSuffix}' "$__ws_exec_rc"`,
  };
}

function cleanCommandOutput(output: string, { inputEchoed, command, doneCommand }: CleanCommandOutputOptions): string {
  let cleaned = output;
  if (inputEchoed) cleaned = stripEchoedLine(cleaned, command);
  cleaned = stripEchoedLine(cleaned, doneCommand, { allowAttached: true });
  return cleaned.replace(/^\r?\n/, '').replace(/\r?\n\r?\n$/, '\n');
}

export { DEFAULT_TIMEOUT_MS, WebSocketExecError, buildMarkers, buildShellCommands, cleanCommandOutput };

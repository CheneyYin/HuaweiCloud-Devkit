// Interactive-terminal IO for the setup CLI, extracted from setup-cli.ts:
// the one-shot confirmation, plain line questions, and raw-mode secret reads.
// No agent knowledge lives here.

import { createInterface } from 'node:readline';

// One-shot confirmation state: cmdReinstall marks the session confirmed
// after the user's first yes, so the nested uninstall's confirm calls
// auto-pass instead of re-asking for the same decision.
let confirmed = false;

export function markConfirmed(): void {
  confirmed = true;
}

export async function confirm(msg: string): Promise<boolean> {
  if (confirmed) return true;
  if (!process.stdin.isTTY) {
    console.log('Non-interactive shell: skipping confirmation (declined).');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((ok) => {
    rl.question(`${msg} [y/N] `, (a) => {
      rl.close();
      ok(a.toLowerCase() === 'y' || a.toLowerCase() === 'yes');
    });
  });
}

export function readLineQuestion(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Cannot read "${prompt.trim()}" securely in a non-interactive session. Set HW_ACCESS_KEY/HW_SECRET_KEY environment variables instead, or run "npx huaweicloud-devkit auth init" in a real terminal.`,
    );
  }

  process.stdout.write(prompt);
  const wasRaw: boolean = process.stdin.isRaw === true;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\b' || ch === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = (): void => {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    process.stdin.on('data', onData);
  });
}

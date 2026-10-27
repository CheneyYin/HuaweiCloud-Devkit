// The interactive install-planning family, extracted from setup-cli.ts: the
// multi-agent selection prompt and the zero-detection fallback prompt (the
// readline flows). The target detection + planning live in
// install-plan.ts; the generic-MCP-agent config family in
// mcp-agent-config.ts.

import { createInterface } from 'node:readline';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';

export const AGENT_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  'codex-desktop': 'Codex Desktop',
  codearts: 'CodeArts',
  'codearts-work': 'CodeArts Work',
  workbuddy: 'WorkBuddy',
  dsh: 'DSH',
  officeace: 'OfficeAce',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  atomcode: 'AtomCode',
};

export function promptSelectAgents(detected: string[]): Promise<string[] | null> {
  if (!process.stdin.isTTY) {
    console.error(
      `Multiple agents detected (${detected.join(', ')}). Cannot prompt in a non-interactive shell — ` +
        'specify `--target <agent>` or `--target all`.',
    );
    return Promise.resolve(null);
  }
  const question = [
    'Multiple agents detected. Select which to install (multi-select):',
    ...detected.map((name, i) => `  ${i + 1}) ${AGENT_LABELS[name] || name}`),
    'Enter numbers separated by commas/spaces, "all" for every detected, Enter to install all detected, or "0" to cancel: ',
  ].join('\n');
  return new Promise<string[] | null>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      const answer = (a || '').trim().toLowerCase();
      if (answer === '0' || answer === 'n' || answer === 'no' || answer === 'q') {
        resolve(null);
        return;
      }
      if (answer === '' || answer === 'all') {
        resolve(detected.slice());
        return;
      }
      const parts = answer.split(/[\s,，]+/).filter(Boolean);
      const indices = new Set<number>();
      for (const part of parts) {
        const n = Number(part);
        if (Number.isSafeInteger(n) && n >= 1 && n <= detected.length) {
          indices.add(n - 1);
        } else {
          console.error(`Invalid selection: "${part}". Installing all detected.`);
          resolve(detected.slice());
          return;
        }
      }
      // Every index was range-checked against detected.length when added.
      resolve([...indices].map((i) => detected[i]!));
    });
  });
}

export function promptZeroDetect(): Promise<InstallPlan> {
  if (!process.stdin.isTTY) {
    console.error('No supported agent detected.');
    console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
    console.error('Use --target <agent> to specify.');
    return Promise.resolve({ abort: true });
  }
  const question = [
    'No supported agent detected.',
    'What would you like to do?',
    '  1) Install to a specific agent (e.g. codex)',
    '  2) Install to all supported agents (--target all)',
    '  3) Wire up a generic MCP agent (Claude Code / Cursor / custom MCP client)',
    '  0) Exit',
    'Enter choice: ',
  ].join('\n');
  return new Promise<InstallPlan>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (): void => {
      rl.question(question, (a) => {
        const answer = (a || '').trim().toLowerCase();
        if (answer === '1') {
          rl.question('Enter agent target (e.g. codex): ', (t) => {
            const val = (t || '').trim().toLowerCase();
            rl.close();
            if (val === 'all' || SUPPORTED_AGENT_TARGETS.includes(val)) {
              resolve({ explicit: true, target: val });
            } else {
              console.error(`Unknown target: ${val}`);
              console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
              resolve({ abort: true });
            }
          });
          return;
        }
        if (answer === '2') {
          rl.close();
          resolve({ explicit: true, target: 'all' });
          return;
        }
        if (answer === '3') {
          rl.close();
          resolve({ mcp: true });
          return;
        }
        if (answer === '' || answer === '0' || answer === 'n' || answer === 'no' || answer === 'q') {
          rl.close();
          resolve({ abort: true });
          return;
        }
        console.error(`Invalid choice: "${answer}"`);
        ask();
      });
    };
    ask();
  });
}

// resolveInstallTarget/promptZeroDetect results share the original JS duck-typed
// shape: each command path fills only the fields it cares about.
export interface InstallPlan {
  abort?: boolean;
  mcp?: boolean;
  explicit?: boolean;
  target?: string;
  subset?: string[];
}

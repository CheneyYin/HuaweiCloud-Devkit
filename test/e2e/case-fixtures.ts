// Case fixture assembly: seed the throwaway home and workdir before the
// agent runs, and render the one prompt interpolation token.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { E2eCase } from './types.ts';

export function seedHome(home: string, fixtures: E2eCase['fixtures']): void {
  for (const [relPath, content] of Object.entries(fixtures.home ?? {})) {
    const target = join(home, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

export function seedWorkdir(workdir: string, fixtures: E2eCase['fixtures']): void {
  for (const [relPath, content] of Object.entries(fixtures.workdir ?? {})) {
    const target = join(workdir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

// {workdir} → absolute path: the one interpolation token, because the agent
// must receive the path only the runner can know. No other templating —
// prompts stay literal data.
export function renderPrompt(prompt: string, workdir: string): string {
  return prompt.replaceAll('{workdir}', workdir);
}

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

// Load-smoke for the V1/V2 dual export: the module is imported for real (no
// opencode host exists in CI), both loaders' contracts are driven, and the
// telemetry spool lands in a temp tree — the tracker computes its spool dir
// relative to import.meta.url, so the file is COPIED into a fixtureDir first
// and import caching is bustable per test via distinct copies.
const TRACKER_SRC = fileURLToPath(new URL('../integrations/opencode/hooks/skill-tracker.js', import.meta.url));

interface TrackerModule {
  default: {
    id?: string;
    server(): Promise<Record<string, (input: unknown, output: unknown) => void>>;
    setup(ctx: unknown): Promise<() => void>;
  };
}

async function loadTracker(prefix: string): Promise<{ mod: TrackerModule; spoolDir: string }> {
  // Replicate the deployed layout (file one level deep under a parent): the
  // tracker resolves its spool dir as <selfDir>/../huaweicloud-plugins/telemetry.
  const dir = fixtureDir(`skill-tracker-${prefix}-`);
  const trackerPath = join(dir, 'hooks', 'skill-tracker.mjs');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  copyFileSync(TRACKER_SRC, trackerPath);
  const mod = (await import(pathToFileURL(trackerPath).href)) as TrackerModule;
  return { mod, spoolDir: join(dir, 'huaweicloud-plugins', 'telemetry') };
}

function readEvents(spoolDir: string): Array<{ key: string; value: string; capability?: string }> {
  const path = join(spoolDir, 'hook-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { key: string; value: string; capability?: string });
}

test('V1 loader: server() returns the legacy hooks map and captures hcloud reads', async () => {
  const { mod, spoolDir } = await loadTracker('v1');
  assert.equal(mod.default.id, 'huaweicloud-skill-tracker');
  const hooks = await mod.default.server();
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  hooks['tool.execute.before']!({ tool: 'bash' }, { args: { command: 'hcloud ECS ListServersDetails' } });
  const events = readEvents(spoolDir);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.key, 'cli:read');
  assert.equal(events[0]!.value, 'hcloud ECS ListServersDetails');
  assert.equal(events[0]!.capability, 'cli');
});

test('V2 loader: setup(ctx) registers on the tool domain, returns a callable cleanup, captures writes', async () => {
  const { mod, spoolDir } = await loadTracker('v2');
  let registered: ((event: unknown) => void) | undefined;
  const ctx = {
    tool: {
      hook: async (_name: string, fn: (event: unknown) => void) => {
        registered = fn;
      },
    },
  };
  const cleanup = await mod.default.setup(ctx);
  // A V2 host may invoke the setup return value unguarded — it must be a
  // callable no-op (undefined is not callable).
  assert.equal(typeof cleanup, 'function');
  assert.doesNotThrow(() => cleanup());
  assert.ok(registered, 'the hook was registered via ctx.tool.hook');

  await registered!({ tool: 'bash', input: { command: 'hcloud ECS CreateServers --cli-region=cn-north-4' } });
  // Non-bash tools never reach the classifier.
  await registered!({ tool: 'edit', input: { command: 'hcloud ECS DeleteServers' } });
  const events = readEvents(spoolDir);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.key, 'cli:write');
  assert.equal(events[0]!.value, 'hcloud ECS CreateServers');
});

test('the telemetry opt-out gates the spool on both loader generations', async () => {
  const previous = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
  try {
    const { mod, spoolDir } = await loadTracker('off');
    const hooks = await mod.default.server();
    hooks['tool.execute.before']!({ tool: 'bash' }, { args: { command: 'hcloud ECS ListServersDetails' } });
    assert.equal(readEvents(spoolDir).length, 0, 'nothing is collected while telemetry is off');
  } finally {
    if (previous === undefined) delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
    else process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = previous;
  }
});

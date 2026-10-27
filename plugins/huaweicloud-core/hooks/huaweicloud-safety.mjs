import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// npm tarballs and built checkouts carry dist/; a raw git or marketplace copy
// of the plugin does not. Prefer the compiled module and fall back to the
// TypeScript source (Node >= 22.18 strips types outside node_modules) so the
// PreToolUse safety gate keeps running instead of crashing open.

const DENY_PREFIX = 'Huawei Cloud safety hook blocked this action: ';

function commandText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (toolInput && typeof toolInput === 'object') {
    const values = [];
    for (const key of ['command', 'cmd', 'script', 'args', 'arguments']) {
      const value = toolInput[key];
      if (Array.isArray(value)) values.push(value.map(String).join(' '));
      else if (value !== undefined && value !== null) values.push(String(value));
    }
    if (values.length > 0) return values.join('\n');
    return JSON.stringify(toolInput);
  }
  return JSON.stringify(toolInput);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_PREFIX + reason,
      },
    }) + '\n',
  );
}

// A payload too broken to load its own policy (missing/corrupt policy.json —
// DEFAULT_POLICY throws at module load) cannot classify safely either: deny
// fail-closed instead of dying with no verdict, which a PreToolUse harness
// reads as "allow" (the py twin's fail-closed posture, interrogate round 1).
// The import sits AFTER deny()'s declaration on purpose — the catch arm calls
// it, and a module-scope call above the declaration would hit the TDZ.
let classifyTextCommand;
try {
  const policyModule = existsSync(join(__dirname, '..', 'dist', 'safety-policy.js'))
    ? await import('../dist/safety-policy.js')
    : await import('../src/safety-policy.ts');
  ({ classifyTextCommand } = policyModule);
} catch {
  deny('the safety policy failed to load; commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.');
  // Exit-0-with-verdict is the hook's contract (the py deny's sys.exit(0)):
  // main() must never run against an unloaded classifier. The
  // n/no-process-exit override covers this entry point.
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = readStdin();
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  const text = commandText(data.tool_input ?? {});
  const result = classifyTextCommand(text);
  if (result.decision === 'deny') deny(result.reason);
}

main();

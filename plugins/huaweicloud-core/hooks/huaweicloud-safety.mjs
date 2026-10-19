import { readFileSync } from 'node:fs';

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

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const input = readStdin();
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  // Dynamic import so a missing or corrupt safety/policy.json fails SAFE:
  // a crashed hook process is a non-blocking error for hook runners (the
  // tool call proceeds), so the module-load failure must surface as an
  // explicit deny instead — matching the Python layer's posture.
  const { classifyTextCommand } = await import('../src/safety-policy.mjs');
  const text = commandText(data.tool_input ?? {});
  const result = classifyTextCommand(text);
  if (result.decision === 'deny') deny(result.reason);
}

main().catch(() => {
  deny('safety policy failed to load; blocking this action (fail-safe).');
});

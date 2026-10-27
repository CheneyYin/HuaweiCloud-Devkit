import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('Windows script wrappers (cmd / powershell / pwsh) keep wrapped writes denied (#731/#760)', () => {
  const denied = [
    // Quoted one-argument payloads, every spelling family.
    'cmd /c "hcloud ECS DeleteServers --server.id=1"',
    'cmd.exe /c "hcloud ECS DeleteServers --server.id=1"',
    'C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers --server.id=1"',
    'powershell -Command "hcloud ECS DeleteServers --server.id=1"',
    'powershell -command "hcloud ECS DeleteServers --server.id=1"',
    'powershell.exe -Command "hcloud OBS rm obs://bucket/obj"',
    'pwsh -Command "hcloud ECS CreateServers --flavor=x"',
    // Unquoted payloads: both shells take the ENTIRE remainder, so the
    // joined line classifies (not a truncation artifact).
    'cmd /k hcloud ECS DeleteServers --server.id=1',
    'powershell -c hcloud ECS DeleteServers --server.id=1',
    'pwsh.exe -c hcloud CCE DeleteCluster --cluster_id=x',
    // Option regions before the script flag — the canonical PowerShell
    // spelling and cmd's robust-quoting idioms; unbounded and order-free
    // (any option count, unlisted value-taking options); `//c` Git-Bash,
    // glued `/c"…"`, colon-attached payloads; the positional command
    // binding; drive-qualified bins and path-qualified prefixes.
    'powershell -NoProfile -Command "hcloud ECS DeleteServers --server.id=1"',
    'powershell -ExecutionPolicy Bypass -Command "hcloud ECS DeleteServers"',
    'powershell -WindowStyle Hidden -Command "hcloud ECS DeleteServers"',
    'powershell -com "hcloud ECS DeleteServers"',
    'powershell -Command:hcloud ECS DeleteServers',
    'powershell -Command:"hcloud ECS DeleteServers --server.id=1"',
    'powershell -c"hcloud ECS DeleteServers"',
    'cmd /c"hcloud ECS DeleteServers" --x=1',
    'cmd /d /c hcloud ECS DeleteServers --server.id=1',
    'cmd /s /c "hcloud ECS DeleteServers --server.id=1"',
    'cmd //c "hcloud ECS DeleteServers --server.id=1"',
    'cmd /c"hcloud ECS DeleteServers --server.id=1"',
    'cmd /q /d /e:on /f:on /v:on /a /u /s /x /c hcloud ECS DeleteServers --server.id=1',
    'powershell hcloud ECS DeleteServers --server.id=1',
    'powershell -NoProfile hcloud ECS DeleteServers --server.id=1',
    'C:\\hcloud.exe ECS DeleteServers --server.id=1',
    'd:hcloud.exe ECS DeleteServers --server.id=1',
    'cmd /c "C:\\Tools\\hcloud.exe ECS DeleteServers --server.id=1"',
    '/usr/bin/sudo -u root hcloud ECS DeleteServers --server.id=1',
    '/usr/bin/SUDO hcloud ECS DeleteServers --server.id=1',
    'timeout 1.5 hcloud ECS DeleteServers --server.id=1',
    'cmd /c start "t" hcloud ECS DeleteServers --server.id=1',
    'cmd /c start "t" C:\\hcloud.exe ECS DeleteServers',
    'bash -c "cmd /c \\"hcloud ECS DeleteServers\\""',
    'bash -c "powershell -Command \\"hcloud ECS DeleteServers\\""',
    // Compound inner scripts and wrapper nesting.
    'cmd /c "hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1"',
    'powershell -Command "echo hi; hcloud ECS DeleteServers --server.id=1"',
    'cmd /c "bash -c \'hcloud ECS DeleteServers\'"',
    // cmd.exe launch builtins re-base onto the child; PowerShell's
    // call-operator scriptblock, glued and spaced.
    'cmd /c start hcloud ECS DeleteServers --server.id=1',
    'cmd /c start /b hcloud ECS DeleteServers',
    'cmd /c call hcloud ECS DeleteServers',
    'powershell -Command "& {hcloud ECS DeleteServers}"',
    'powershell -Command "& { hcloud ECS DeleteServers }"',
    // Quote-mangled wrapper heads classify like quote-mangled bins.
    'cm\'d\' /c "hcloud ECS DeleteServers"',
    'powers\'hell\' -Command "hcloud ECS DeleteServers"',
    // Path-qualified wrappers after separators and with compound payloads.
    'echo x; C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"',
    'echo hi && C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"',
    'C:\\Windows\\System32\\cmd.exe /c "echo hi; hcloud ECS DeleteServers"',
    // Composed with a command-position prefix.
    'sudo cmd /c "hcloud ECS DeleteServers"',
    'sudo powershell -NoProfile -Command "hcloud ECS DeleteServers"',
  ];
  for (const cmd of denied) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'write', cmd);
  }
  // Wrapped reads stay allowed — over-broad unwrapping must not regress.
  const allowed = [
    'cmd /c "hcloud ECS ListServers"',
    'cmd /k hcloud ECS ListServers',
    'powershell -Command "hcloud ECS ListServers"',
    'pwsh -c hcloud ECS ListServers',
    'powershell -NoProfile -Command "hcloud ECS ListServers"',
    'powershell -WindowStyle Hidden -Command "hcloud ECS ListServers"',
    'powershell hcloud ECS ListServers',
    'cmd /c start /wait hcloud ECS ListServers',
  ];
  for (const cmd of allowed) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'allow', cmd);
    assert.equal(result.risk, 'read_only', cmd);
  }
  // Degenerate and non-script forms take no inline command; the
  // positional binding only runs commands, and non-hcloud positional
  // payloads stay allowed. The encoded payload is a documented residual
  // (opaque to a text gate).
  for (const cmd of [
    'cmd',
    'cmd /c',
    'cmd /c "echo hi"',
    'powershell -File deploy.ps1',
    'powershell Get-Process',
    'powershell',
    'powershell -EncodedCommand aGNsb3VkIEVDUyBEZWxldGVTZXJ2ZXJz',
    'start notepad file.txt',
    'see the hcloud docs here',
    'echo "hcloud ECS DeleteServers"',
  ]) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
  }
  // The argv face unwraps the same way.
  const argvResult = classifyHcloudArgs(['cmd', '/c', 'hcloud ECS DeleteServers --server.id=1']);
  assert.equal(argvResult.decision, 'deny');
  assert.equal(argvResult.risk, 'write');
  // POSIX escapes still eat backslashes outside drive paths (the
  // preservation is scoped to `X:` words).
  assert.equal(classifyTextCommand('hcloud ECS DeleteServers --filter=g\\et').decision, 'deny');
});

test('the secret vocabulary is derived from policy.json and mirrored in the risk-rule catalog', () => {
  // The TS text faces and the py SECRET_READ_RE both derive from
  // policy.blockedSecretOperations; the cloud-risk-rules.json
  // secret-value-read regex is the one remaining hand-maintained copy.
  // Assert it SEMANTICALLY: every policy entry matches the rule regex, and
  // stem entries keep their boundary guards there (longer names exempt).
  const policy = JSON.parse(
    readFileSync(join(repoRoot, 'plugins', 'huaweicloud-core', 'safety', 'policy.json'), 'utf8'),
  );
  const rules = JSON.parse(
    readFileSync(join(repoRoot, 'plugins', 'huaweicloud-core', 'safety', 'rules', 'cloud-risk-rules.json'), 'utf8'),
  );
  const rule = rules.rules.find((r: { id: string }) => r.id === 'hwc-command-secret-value-read');
  const condition = rule.match.any.find((c: { regex: string }) => /ShowSecret/i.test(c.regex));
  const regex = new RegExp(condition.regex, 'i');
  for (const op of policy.blockedSecretOperations) {
    assert.ok(regex.test(` ${op} `), `${op} must be matched by the rule regex`);
  }
  const loweredOps = new Set(policy.blockedSecretOperations.map((op: string) => op.toLowerCase()));
  const stems = policy.blockedSecretOperations.filter((op: string) =>
    policy.blockedSecretOperations.some(
      (other: string) => other !== op && other.toLowerCase().startsWith(op.toLowerCase()),
    ),
  );
  // Guard drift in the hand-maintained JSON copy must not false-pass: pin
  // both boundary directions AND the separator members of the guard class
  // against the same corpus the TS face is pinned to.
  for (const stem of stems) {
    const s = stem.toLowerCase();
    assert.ok(!regex.test(` ${stem}List `), `${stem}List must stay exempt (lookahead guard present)`);
    assert.ok(!regex.test(`my${s}`), `my${s} must stay exempt (lookbehind guard present)`);
    for (const shape of [`${s}-demo`, `${s}_v`, `${s}.x`, `${s}/x`, `x/${s}`]) {
      assert.ok(!regex.test(shape), `${shape} must stay exempt (full guard class present)`);
    }
    assert.ok(regex.test(`--secret_name=${s}`), `--secret_name=${s} must still deny (exact stem)`);
  }
  // Self-specific entries stay UNGUARDED substrings in the JSON copy:
  // embedded shapes must still match (the hook faces' documented contract).
  for (const op of policy.blockedSecretOperations) {
    if (stems.includes(op)) continue;
    assert.ok(regex.test(`${op.toLowerCase()}-demo`), `${op}-demo must still match (unguarded substring)`);
  }
  // Reverse containment: no stale JSON-only vocabulary that policy dropped.
  // Strip lookaround guards FIRST (they carry their own parens), then drop
  // the wrapping group and split alternatives.
  const guardStripped = condition.regex
    .replace(/\(\?<!\[[^\]]*\]\)|\(\?!\[[^\]]*\]\)/g, '')
    .replace(/^[()]+|[()]+$/g, '')
    .split('|')
    .map((part: string) => part.trim().toLowerCase())
    .filter((part: string) => part !== '');
  for (const part of guardStripped) {
    assert.ok(
      loweredOps.has(part),
      `JSON rule carries "${part}" which policy.blockedSecretOperations lacks — stale vocabulary`,
    );
  }
});

test('the skill-quality-cli wrapper does not launder hcloud classification', () => {
  // The adopted huawei-cloud-* service skills teach the wrapper; the
  // command-position seam unwraps it so embedded hcloud keeps its verdict.
  const deny = [
    'skill-quality-cli run --skill-name ecs -- hcloud ECS CreateServers --server.name=x',
    'skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1',
    '~/.local/bin/skill-quality-cli run --skill-name x -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1',
    '/usr/local/bin/skill-quality-cli run -- hcloud OBS rm obs://bucket/obj -f',
    'sudo skill-quality-cli run -- hcloud ECS CreateServers --server.name=x',
    'npx huaweicloud-devkit secret exec --env K=x -- bash -c "skill-quality-cli run -- hcloud ECS DeleteServers"',
    // The separator decision lives inside the flag walk: a `--` owned by
    // the CHILD argv never launders the wrapper.
    'skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1 --',
    'skill-quality-cli run hcloud ECS DeleteServers -- --server.id=1',
    // Global no-value flags sit between the bin and the subcommand.
    'skill-quality-cli --no-auto-upgrade run -- hcloud ECS DeleteServers --server.id=1',
    // Windows shims and the ELF tier are the same tool.
    'skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1',
    '~/.local/bin/skill-quality-cli.bin run -- hcloud ECS DeleteServers --server.id=1',
    // Quote-mangled bin/subcommand: the shell executes the canonical name.
    "skill'-'quality'-'cli run -- hcloud ECS DeleteServers --server.id=1",
    "skill-quality-cli ru'n' -- hcloud ECS DeleteServers",
    // Every value flag is pinned, including the hcloud-value ambiguity
    // (the child starts AT the hcloud token — the deny composes).
    'skill-quality-cli run --session-id s hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1',
    // Same-wrapper nesting with a compound inner script reaches the
    // innermost script through the fixpoint candidates.
    'skill-quality-cli run --skill-name a -- skill-quality-cli run --skill-name b -- bash -c "echo hi; hcloud ECS DeleteServers --server.id=1"',
    // The every-position scan is inherited doctrine: prose that mentions a
    // wrapped write, and heredoc data quoting one, also deny.
    'echo skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1',
    // Unknown flag grammar fails CLOSED: the REMAINDER walk falls back to
    // the first hcloud bin in the tail (abbreviations, underscores,
    // unknown value flags, pre-run flags all compose the deny).
    'skill-quality-cli run --config /etc/x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-n x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill_name x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli --json run -- hcloud ECS DeleteServers --server.id=1',
    // Pre-run value flags occupy the `run` position — the same laundering
    // shape, closed by the pre-run fallback.
    'skill-quality-cli --config x run -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli --skill-name x run -- hcloud ECS DeleteServers --server.id=1',
    // Script-wrapped children classify identically with and without the
    // separator (the verbatim child reaches the nested-script candidates).
    'skill-quality-cli run bash -c "hcloud ECS DeleteServers --server.id=1"',
    'skill-quality-cli run --config x bash -c "hcloud ECS DeleteServers"',
    // eval-class script children and case-variant shells re-base the same
    // way; the value-flag slot fails closed for script heads too.
    'skill-quality-cli run --config x eval "hcloud ECS DeleteServers"',
    'skill-quality-cli run --config x BASH -c "hcloud ECS DeleteServers"',
    'skill-quality-cli run --json bash -c "hcloud ECS DeleteServers"',
    // The wrapper's own `--` separator is AUTHORITATIVE when it follows a
    // wrapper-ambiguous value slot: the separator's child classifies, not
    // the slot re-base (which would swallow the separator and misread the
    // operation from nonFlags[1]).
    'skill-quality-cli run --skill-name hcloud -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-name eval -- hcloud ECS DeleteServers --server.id=1',
    // A lone-shell-token child must not crash the py layer (the write in
    // the NEXT segment still denies independently).
    'skill-quality-cli run bash && hcloud ECS DeleteServers --server.id=1',
    // Quote-mangled pre-run tokens canonicalize through the normalization.
    "skill-quality-cli --no-auto-'upgrade' run -- hcloud ECS DeleteServers --server.id=1",
    "skill-quality-cli -'-' run -- hcloud ECS DeleteServers --server.id=1",
    // Windows path-qualified bins match through the raw-form candidate
    // (TS fail-closed: the TS tokenizer keeps backslashes; the py segment
    // splitter unescapes them, so the layers differ on this shape — the
    // POSIX shell never executes it either way).
    'C:\\tools\\skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1',
    'C:\\tools\\huaweicloud-devkit secret exec --env K=x -- hcloud ECS DeleteServers --server.id=1',
    // POSIX escape mangling matches through the normalized candidate.
    'skill\\-quality\\-cli run -- hcloud ECS DeleteServers --server.id=1',
  ];
  for (const cmd of deny) {
    assert.equal(classifyTextCommand(cmd).decision, 'deny', cmd);
  }
  const allow = [
    'skill-quality-cli run --skill-name ecs -- hcloud ECS ListServers',
    'skill-quality-cli run -- hcloud CSMS ListSecrets',
    'skill-quality-cli run --skill-name x hcloud ECS ListServers --cli-region=cn-north-4',
    'skill-quality-cli report --input x',
    'skill-quality-cli install',
    'skill-quality-cli run -- -- hcloud ECS ListServers',
    // The `--` separator is authoritative: a non-hcloud child stays
    // non-hcloud even when a path token later in the tail looks like one.
    'skill-quality-cli run -- ls /opt/hcloud',
    'skill-quality-cli report run --input run.log',
    // A lone trailing hcloud token is a subcommand argument, not a child —
    // the fallbacks require a following token before re-basing. This also
    // covers the value-flag slot: a trailing flag VALUE named hcloud.
    'skill-quality-cli report --input hcloud && echo ok',
    'skill-quality-cli install hcloud && echo ok',
    'skill-quality-cli run ls hcloud && echo ok',
    'skill-quality-cli run --skill-name hcloud && echo ok',
    'skill-quality-cli run --json hcloud && echo ok',
    // A bare `bash deploy.sh` (no -c) is not a script head — no re-base,
    // no operation read off the script filename.
    'skill-quality-cli run --config x bash deploy.sh',
    'skill-quality-cli run --config x bash install.sh',
    // `bash -c x -- hcloud …` executes only the script `x`; the `--`
    // token makes everything after it bash POSITIONAL parameters ($0…),
    // so the hcloud tokens never execute — allow is the true semantics.
    'skill-quality-cli run --skill-name bash -c x -- hcloud ECS DeleteServers --server.id=1',
    // A lone shell token as the child is not a script (no -c, no script
    // argument) — allow, no crash in either layer.
    'skill-quality-cli run bash',
    'skill-quality-cli run -- bash',
  ];
  for (const cmd of allow) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
  }
});

test('ANSI-C KEYWORD mangling denies via the write-vocabulary clause (#927 audit bypass fix)', () => {
  // $'\x68'cloud = hcloud in POSIX shells — the h exists only inside the
  // escape, so neither the raw form nor the quote-stripped shadow carries
  // 'hcloud'. The shadow DOES carry 'deleteservers', so the
  // expansion-bearing + write-vocab-hit line denies fail-closed.
  for (const cmd of [
    "$'\x68'cloud ECS DeleteServers --server.name=x",
    "hcl$'\x6f'ud ECS DeleteServers --server.name=x",
    "h$'\x63'loud ECS DeleteServers --server.name=x",
  ]) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', `${cmd} must deny (ANSI-C keyword bypass)`);
    assert.equal(result.risk, 'secret');
  }
  // Benign expansion + write-word in prose must NOT trip the clause.
  assert.equal(classifyTextCommand('echo $HOME/docs/CreateNotes.md').decision, 'allow');
  assert.equal(classifyTextCommand('grep "Delete" $FILE').decision, 'allow');
});

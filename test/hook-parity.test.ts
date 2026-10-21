import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.ts';

// The TS classifier and the python hook are two hand-maintained
// implementations of one safety policy. This battery runs the SAME command
// list through both and asserts identical verdicts, so vocabulary drift
// between the layers (the failure mode behind several review findings)
// fails CI instead of shipping.

const hookPath = join('plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.py');

function join(...parts: string[]): string {
  return parts.join('/');
}

const BATTERY: Array<[command: string, verdict: 'deny' | 'allow']> = [
  // Reveal face, canonical and adversarial spellings.
  ['npx huaweicloud-devkit secret get secret://user/hw-sk --stdout', 'deny'],
  ["npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout", 'deny'],
  ['npx huaweicloud-devkit@latest secret get secret://user/hw-sk', 'deny'],
  ['npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout', 'deny'],
  ["npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout", 'deny'],
  ['npx huaweicloud-devkit secret `echo get` secret://user/hw-sk --stdout', 'deny'],
  ["npx $'\\x68'uaweicloud-devkit secret get secret://user/hw-sk --stdout", 'deny'],
  ['echo secret get secret://user/hw-sk --stdout | xargs npx huaweicloud-devkit', 'deny'],
  ['npx huaweicloud-devkit secret list', 'allow'],
  ['npx huaweicloud-devkit secret exec --env K=secret://user/ak -- node script.js', 'allow'],
  // Write gate: separators, command positions, obfuscation.
  ['hcloud ECS CreateServers --server.name=x', 'deny'],
  ['hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x', 'deny'],
  ['echo hello\nhcloud ECS CreateServers --server.name=x', 'deny'],
  ['hcloud ECS ListServers & hcloud ECS DeleteServers', 'deny'],
  ['for i in 1 2 3; do hcloud ECS DeleteServers --server.id=$i; done', 'deny'],
  ['if hcloud ECS DeleteServers --server.id=x; then echo done; fi', 'deny'],
  ['eval "hcloud ECS DeleteServers --server.id=x"', 'deny'],
  ['exec hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['{ hcloud ECS DeleteServers; }', 'deny'],
  ['case $x in a) hcloud ECS DeleteServers;; esac', 'deny'],
  ['timeout 30 hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['sudo -u root hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['nice -n 10 hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['cat <(hcloud ECS DeleteServers --server.id=x)', 'deny'],
  ['hcloud ECS \\\nDeleteServers --server.id=x', 'deny'],
  ["hclou'd' ECS DeleteServers", 'deny'],
  ["hcloud ECS $'\\x43'reateServers --server.name=x", 'deny'],
  ['npx huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS DeleteServers"', 'deny'],
  [
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers"',
    'deny',
  ],
  ['hcloud OBS rm obs://bucket/obj -f', 'deny'],
  // KooCLI 7.3.12 obsutil write subcommands — the pin keeps the TS and py
  // OBSUTIL_WRITES vocabularies from drifting apart on the new names.
  ['hcloud OBS bucket-tagging obs://b -method=put', 'deny'],
  ['hcloud OBS object-tagging obs://b -method=delete', 'deny'],
  ['hcloud OBS encryption obs://b -method=put -localfile=e.xml', 'deny'],
  ['hcloud OBS custom-domain obs://b -cname=x.com', 'deny'],
  ['hcloud OBS mirror-back-to-source obs://b -method=delete', 'deny'],
  ['hcloud OBS put-public-access-block obs://b -public-access-block-configuration=BlockPublicAcls=true', 'deny'],
  ['hcloud OBS delete-public-access-block obs://b', 'deny'],
  // The read variants of the same families stay allowed on BOTH layers.
  ['hcloud OBS get-public-access-block obs://b', 'allow'],
  ['hcloud OBS check obs://src obs://dst', 'allow'],
  // Case-variant obsutil subcommands: the vocab lookup must be
  // case-insensitive on BOTH layers (the binary rejects these, but the
  // policy must not lean on that).
  ['hcloud OBS RM obs://b -f', 'deny'],
  ['hcloud OBS Abort obs://b/key', 'deny'],
  // The live share-authorization family + the abort/archive catches.
  ['hcloud OBS create-share obs://b', 'deny'],
  ['hcloud OBS update obs://b', 'deny'],
  ['hcloud OBS abort obs://b/key -f', 'deny'],
  ['hcloud OBS archive obs://b', 'deny'],
  ['hcloud ECS ListServers --cli-region=cn-north-4', 'allow'],
  ['hcloud ECS CreateServers --help', 'allow'],
  ['hcloud OBS ls obs://bucket', 'allow'],
  // Credential files: quoting, normalization, cd-split, the import file.
  ["cat ~/.config/huawei'cloud/secrets'/.master-key", 'deny'],
  ['cat ~/.config/huaweicloud/./credentials.json', 'deny'],
  ['cat ~/.config/huaweicloud//secrets/.master-key', 'deny'],
  ['cd ~/.config/huaweicloud && cat secrets/.master-key', 'deny'],
  ['cat ~/.config/huaweicloud/creds-import.json', 'deny'],
  ['cat /proc/self/environ', 'deny'],
  // Env family: dumps and legitimate neighbors.
  ['env', 'deny'],
  ['printenv', 'deny'],
  ['export', 'deny'],
  ['declare -p', 'deny'],
  ['env | cat', 'deny'],
  ['env | grep HW_ACCESS_KEY', 'deny'],
  ['echo $HW_VAULT_MASTER_KEY', 'deny'],
  ['echo $HW_SECRET_KEY', 'deny'],
  ['echo $HUAWEICLOUD_SECRET_ACCESS_KEY', 'deny'],
  ['echo ${HUAWEICLOUD_SECRET_ACCESS_KEY}', 'deny'],
  ['printenv HWC_SECRET_ACCESS_KEY', 'deny'],
  ['env | grep HW_SECRET_ACCESS_KEY', 'deny'],
  ['env HW_REGION=cn-north-4 hcloud ECS ListServers', 'allow'],
  ['set -e', 'allow'],
  ['make env', 'allow'],
  ['rg env', 'allow'],
  ['printenv PATH', 'allow'],
  ["echo '$HW_SECRET_KEY is a literal'", 'allow'],
  ["echo '$HUAWEICLOUD_SECRET_ACCESS_KEY' is a literal", 'allow'],
  ['echo $HUAWEICLOUD_REGION', 'allow'],
  // Prose and heredocs are not commands; same-line commands after a
  // heredoc operator ARE; nested scripts and xargs feeds classify; leading
  // redirects and path-qualified wrappers sit in command position.
  ['echo "step1; hcloud ECS CreateServers --flavor=x"', 'allow'],
  ['git commit -m "chore: cleanup\nhcloud ECS DeleteServers done"', 'allow'],
  ['cat > plan.txt <<EOF\nflavor=x\nEOF', 'allow'],
  ['cat <<EOF; hcloud ECS DeleteServers --server.id=1\nbody\nEOF', 'deny'],
  ['a=1<<2; echo done; hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["bash -c 'hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1'", 'deny'],
  ['bash -lc "echo x; hcloud ECS DeleteServers"', 'deny'],
  ['echo DeleteServers --server.id=1 | xargs hcloud ECS', 'deny'],
  ['echo DeleteServers | xargs -I {} hcloud ECS {}', 'deny'],
  ['echo ListServers | xargs hcloud ECS', 'allow'],
  ['2>/dev/null hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['<input.txt hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['/usr/bin/time hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['( hcloud ECS DeleteServers --server.id=x )', 'deny'],
  ['( (hcloud ECS DeleteServers) )', 'deny'],
  ['if false; then echo a; elif hcloud ECS DeleteServers --server.id=x; then echo b; fi', 'deny'],
  ['if false; then echo a; else hcloud ECS DeleteServers --server.id=x; fi', 'deny'],
  ['coproc hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['time -p hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['command -p hcloud ECS DeleteServers --server.id=x', 'deny'],
  ["hcloud ECS Cre'ateServers --server.name=x", 'deny'],
  ['hcloud configure show', 'deny'],
  ["hcloud conf'igure' show", 'deny'],
  ["hcloud CSMS show'secret'version --secret_name x", 'deny'],
  ['hcloud CSMS ShowSecret --secret_name prod/db', 'deny'],
  ['hcloud CSMS ShowSecretList', 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret-demo', 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret_version', 'allow'],
  ["echo Show'Secret'", 'deny'],
  ["echo Show'Secret'Version", 'deny'],
  ["echo xshow'secret'version", 'deny'],
  ["echo download'secret'", 'deny'],
  ["echo download'secret'-demo", 'deny'],
  ["echo secret_'string'", 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret', 'deny'],
  ['hcloud CSMS ListSecrets --secret_name=downloadsecret-demo', 'deny'],
  ["hcloud CSMS ListServers; echo download'secret'", 'deny'],
  ['hcloud CSMS ShowSecret --help', 'deny'],
  ['echo ShowSecret', 'deny'],
  // skill-quality-cli wrapper: adopted service skills teach it — the seam
  // unwraps it so embedded hcloud keeps its verdict in both layers.
  ['skill-quality-cli run --skill-name ecs -- hcloud ECS CreateServers --server.name=x', 'deny'],
  ['skill-quality-cli run -- hcloud CSMS ListSecrets', 'allow'],
  ['~/.local/bin/skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x --session-id s hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS ListServers', 'allow'],
  ['skill-quality-cli --no-auto-upgrade run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["skill'-'quality'-'cli run -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1 --', 'deny'],
  ['skill-quality-cli run hcloud ECS DeleteServers -- --server.id=1', 'deny'],
  ['sudo skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  [
    'npx huaweicloud-devkit secret exec --env K=x -- bash -c "skill-quality-cli run -- hcloud ECS DeleteServers"',
    'deny',
  ],
  ["npx huawei'cloud'-devkit secret exec --env K=x -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli run --config /etc/x hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["skill-quality-cli --no-auto-'upgrade' run -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli --config x run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run bash -c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['skill-quality-cli run --config x bash -c "hcloud ECS ListServers"', 'allow'],
  // The wrapper's `--` separator is authoritative only while the flag
  // region is still live: a child-owned `--` never suppresses the
  // fail-closed slot re-base. The reachability scan consumes the wrapper's
  // own value-flag grammar (so an intervening --session-id s pair does not
  // fake unreachability) and treats a script-head slot's `-c` argument as
  // data (so a dash-leading script cannot fake reachability).
  ['skill-quality-cli run --json bash -c "hcloud ECS DeleteServers" -- x', 'deny'],
  ['skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1 --', 'deny'],
  ['skill-quality-cli run --skill-name hcloud -- ECS ListServers', 'allow'],
  ['skill-quality-cli run --json hcloud --session-id s -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name hcloud --skill-name y -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json bash -c "-e; hcloud ECS DeleteServers" -- x', 'deny'],
  // The grammar model resolves wrapper-flag/value pairs between the slot
  // and the real child: the child head (hcloud bin or script head) reached
  // through the wrapper's own flag grammar composes the deny — with or
  // without the separator, and whether the interleaved value is a plain
  // token or the `--` itself.
  ['skill-quality-cli run --json hcloud --session-id s hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud --session-id -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud --session-id s bash -c "hcloud ECS DeleteServers"', 'deny'],
  ['skill-quality-cli run --json eval "-e; hcloud ECS DeleteServers" -- x', 'deny'],
  ['skill-quality-cli run -- ls /opt/hcloud', 'allow'],
  ['skill-quality-cli run ls /opt/hcloud', 'allow'],
  ['hcloud KMS ShowKey', 'allow'],
  ['env -u TERM', 'deny'],
  ['env --unset=TERM', 'deny'],
  ["echo 'a'$HW_SECRET_KEY", 'deny'],
  ['cd ~/.config/huaweicloud && cat credentials.json', 'deny'],
  // Windows script wrappers (#731/#760): cmd /c|/k and
  // powershell|pwsh -Command|-c re-tokenize their payload so wrapped
  // writes deny in BOTH layers; wrapped reads and non-script forms stay
  // allowed; unquoted payloads join the remainder (real shell semantics);
  // options before the script flag (`-NoProfile -Command`, `cmd /d /c`)
  // and cmd.exe launch builtins (`start`/`call`) re-base onto the child.
  ['cmd /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /k hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd.exe /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell.exe -Command "hcloud OBS rm obs://b/x"', 'deny'],
  ['pwsh -Command "hcloud ECS CreateServers --flavor=x"', 'deny'],
  ['pwsh.exe -c hcloud CCE DeleteCluster --cluster_id=x', 'deny'],
  ['cmd /c "hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "echo hi; hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /c "bash -c \'hcloud ECS DeleteServers\'"', 'deny'],
  ['sudo cmd /c "hcloud ECS DeleteServers"', 'deny'],
  // Option regions before the script flag — the canonical PowerShell
  // spelling (`-NoProfile -Command`) and cmd's `/d /s` robust-quoting
  // idioms must not launder the write. The scan is unbounded and
  // order-free: any option count, unlisted value-taking options, `//c`
  // (Git-Bash path conversion), glued `/c"…"`, colon-attached
  // `-Command:"…"`, and PowerShell's POSITIONAL command binding
  // (`powershell hcloud …`) all classify.
  ['powershell -NoProfile -Command "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -NoProfile -NonInteractive -Command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -ExecutionPolicy Bypass -Command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -WindowStyle Hidden -Command "hcloud ECS DeleteServers"', 'deny'],
  ['pwsh -NoLogo -c "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -com "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command:hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command:"hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ["powershell -c:'hcloud ECS DeleteServers --server.id=1'", 'deny'],
  ['powershell -c"hcloud ECS DeleteServers"', 'deny'],
  ['pwsh -c"hcloud ECS DeleteServers" x', 'deny'],
  ['cmd /c"hcloud ECS DeleteServers" --x=1', 'deny'],
  ['cmd /d /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /s /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd //c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /c"hcloud ECS DeleteServers --server.id=1"', 'deny'],
  [
    'powershell -NoProfile -NonInteractive -NoLogo -NoExit -OutputFormat Text -InputFormat Text -ExecutionPolicy Bypass -WorkingDirectory . -Mta -Command hcloud ECS DeleteServers --server.id=1',
    'deny',
  ],
  ['cmd /q /d /e:on /f:on /v:on /a /u /s /x /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell -NoProfile hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell -WindowStyle Hidden hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['C:\\hcloud.exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c "C:\\Tools\\hcloud.exe ECS DeleteServers --server.id=1"', 'deny'],
  // cmd.exe launch builtins inside the payload re-base onto the child.
  ['cmd /c start hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start /b hcloud ECS DeleteServers', 'deny'],
  ['cmd /c "start /wait hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c call hcloud ECS DeleteServers', 'deny'],
  ['cmd /c call /b hcloud ECS DeleteServers', 'deny'],
  // PowerShell call-operator scriptblock, glued and spaced.
  ['powershell -Command "& {hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "& { hcloud ECS DeleteServers }"', 'deny'],
  // Quote-mangled wrapper heads classify like quote-mangled bins.
  ['cm\'d\' /c "hcloud ECS DeleteServers"', 'deny'],
  ['powers\'hell\' -Command "hcloud ECS DeleteServers"', 'deny'],
  // Path-qualified wrappers after separators and with compound payloads —
  // the drive-path backslash preservation keeps the head recognizable.
  ['echo x; C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['echo hi && C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe /c "echo hi; hcloud ECS DeleteServers"', 'deny'],
  ['sudo powershell -NoProfile -Command "hcloud ECS DeleteServers"', 'deny'],
  // Path-qualified command-position prefixes consult their value-flag
  // grammar (basename resolution, any letter case); decimal durations
  // strip in both layers; cmd's `start` consumes an optional quoted
  // TITLE before the child; drive-relative bins (`d:hcloud.exe`) are
  // drive-qualified too; `\"`-nested wrappers inside bash -c regroup
  // (escape-aware quoted spans).
  ['/usr/bin/sudo -u root hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['/usr/bin/SUDO hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['timeout 1.5 hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start "t" hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start "t" C:\\hcloud.exe ECS DeleteServers', 'deny'],
  ['d:hcloud.exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c "d:hcloud.exe ECS DeleteServers --server.id=1"', 'deny'],
  ['bash -c "cmd /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['bash -c "powershell -Command \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "hcloud ECS ListServers"', 'allow'],
  ['cmd /k hcloud ECS ListServers', 'allow'],
  ['powershell -Command "hcloud ECS ListServers"', 'allow'],
  ['pwsh -c hcloud ECS ListServers', 'allow'],
  ['powershell -NoProfile -Command "hcloud ECS ListServers"', 'allow'],
  ['powershell -WindowStyle Hidden -Command "hcloud ECS ListServers"', 'allow'],
  ['powershell hcloud ECS ListServers', 'allow'],
  ['powershell Get-Process', 'allow'],
  ['powershell', 'allow'],
  ['powershell -c hcloud --help', 'allow'],
  ['cmd /d /c dir', 'allow'],
  ['cmd /c start /wait hcloud ECS ListServers', 'allow'],
  ['cmd /c "echo hi"', 'allow'],
  ['powershell -File deploy.ps1', 'allow'],
  ['cmd', 'allow'],
  ['cmd /c', 'allow'],
  // Prose and string literals mentioning hcloud or a write stay
  // unclassified: routing is entry-only and no segment is hcloud-leading.
  ['see the hcloud docs here', 'allow'],
  ['echo "hcloud ECS DeleteServers"', 'allow'],
  ['start notepad file.txt', 'allow'],
  // The xargs feeder supplies the argv: a bare `xargs hcloud` segment
  // fed by a pipe classifies its feeder instead of denying empty-args.
  ['echo List | xargs hcloud && echo done', 'allow'],
  // Wrapper PAYLOAD control grammar: PS scriptblocks (try/catch, foreach/%,
  // begin, switch/default, function+name) re-base onto the body; cmd `if`
  // conditions and the `@` echo-suppression sigil classify; the
  // windows-payload stall re-base (first hcloud bin) closes the rest.
  ['powershell -Command "try { hcloud ECS DeleteServers --server.id=1 } catch {}"', 'deny'],
  ['powershell -Command "1..1 | foreach { hcloud ECS DeleteServers --server.id=1 }"', 'deny'],
  ['powershell -Command "1 | % { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { echo x } catch { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "begin { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "switch (1) { default { hcloud ECS DeleteServers } }"', 'deny'],
  ['powershell -Command "function f { hcloud ECS DeleteServers }; f"', 'deny'],
  ['cmd /c "if defined X hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if exist foo.txt hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if not defined X hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if %ERRORLEVEL%==0 hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "@hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "@hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command:"" hcloud ECS DeleteServers', 'deny'],
  ['powershell -c:"\'" hcloud ECS DeleteServers', 'deny'],
  ['bash -c "powershell -Command \\"try { hcloud ECS DeleteServers }\\""', 'deny'],
  ['echo Delete | /usr/bin/XARGS hcloud ECS', 'deny'],
  // Multi-brace-block payloads: every LATER hcloud occurrence in a
  // windows payload is a live command site (`}` is not a segment
  // separator) — the first block's read does not mask the second block's
  // write. The doubly-nested `\"` form regroups through the
  // escape-aware tokenizers. Quote-mangled drive-qualified bins strip
  // quotes but keep backslashes.
  ['powershell -Command "try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } catch { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "begin { hcloud ECS ListServers } end { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "if (0) { hcloud ECS ListServers } else { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud --help } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } catch { cmd /c hcloud ECS DeleteServers }"', 'deny'],
  ['sudo powershell -NoProfile -Command "try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['bash -c "powershell -Command \\"try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }\\""', 'deny'],
  ['C:\\hclou"d".exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c C:\\hclou"d".exe ECS DeleteServers', 'deny'],
  ['cmd /c "C:\\hclou\'d\' ECS DeleteServers"', 'deny'],
  // Payload stall re-base only denies write-shaped rebases; reads inside
  // payloads stay allowed.
  ['powershell -Command "echo hcloud ECS ListServers"', 'allow'],
  ['powershell -Command "try { hcloud ECS ListServers } finally {}"', 'allow'],
  // Fail-closed asymmetry, pinned deliberately: unquoted write-word
  // mentions inside windows payloads (echo args) re-base and deny, while
  // the identical echo at the bash layer allows — the sqc REMAINDER
  // doctrine's accepted cost.
  ['powershell -Command "echo hcloud ECS DeleteServers"', 'deny'],
  // Glued-brace PS payloads (no whitespace), separator-glued bins
  // (`x&&hcloud`), quote-glued cmd flags with separator-bearing payloads,
  // and prefixes in front of the wrapper: the payload re-segmentation is
  // brace-normalized at extraction, edge-stripped on join, and
  // piece-aware in the stall re-base and later-bin scan.
  ['powershell -Command "try{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}catch{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}finally{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "if(0){}else{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "switch(1){default{hcloud ECS DeleteServers}}"', 'deny'],
  ['cmd /c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"hcloud ECS ListServers;hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"echo x;hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"echo x|hcloud ECS DeleteServers"', 'deny'],
  ['cmd /k"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd //c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd.exe /c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo powershell -Command "echo x;hcloud ECS DeleteServers"', 'deny'],
  ['env X=1 cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['timeout 5 cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['nohup powershell -Command "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['echo x | xargs cmd /c "echo y&&hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}catch{}"', 'allow'],
  // Value-integrity guards: `={`/`:{`-glued and value-internal braces are
  // NOT spaced (argv service/operation positions unchanged), quoted
  // arg-value separators are NOT piece-split, and an empty attached
  // value behaves like the bare flag. cmd `/d <path>` carries its value
  // before /c.
  ['cmd /c "hcloud --cli-jsonInput={x:1} ECS DeleteServers"', 'deny'],
  ['powershell -Command "hcloud --cli-jsonInput={x:1} ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud --cli-region={region} ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud --cli-jsonInput={x:1} configure set --cli-access-key=AK --cli-secret-key=SK"', 'deny'],
  ["cmd /c \"hcloud ECS ListServers --description='a;hcloud;DeleteServers'", 'allow'],
  ["cmd /c \"hcloud ECS ListServers --url='http://x/hcloud&DeleteServers'", 'allow'],
  ['powershell -Command: hcloud ECS DeleteServers', 'deny'],
  ['powershell -c: hcloud ECS DeleteServers', 'deny'],
  ['pwsh -Command: hcloud OBS rm obs://b/o', 'deny'],
  ['powershell -NoProfile -Command: hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command: "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /d C:\\temp /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud ECS CreateServers --cli-jsonInput={x:1}"', 'deny'],
  ['cmd /c "hcloud ECS ListServers --fields=name{1..3}"', 'allow'],
  ['cmd /c "hcloud --cli-jsonInput={\'DeleteServers\':1} ECS ListServers"', 'allow'],
  // Unquoted `&`/`;` in arg text are REAL cmd/PS command separators even
  // glued to values — the piece re-base is correct there.
  ['cmd /c "hcloud ECS List --desc=a&hcloud DeleteServers"', 'deny'],
  // Real cmd SKIPS non-switch junk before /c|/k (Wine/ReactOS raw scan);
  // ReactOS honors /r as a script flag (included fail-closed). The call
  // operator on a parenthesized string literal peels to the canonical
  // bin (routing tail accepts closers).
  ['cmd foo /c hcloud ECS DeleteServers', 'deny'],
  ['cmd foo /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd foo bar baz /c hcloud ECS DeleteServers', 'deny'],
  ['cmd.exe foo /c hcloud ECS DeleteServers', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe foo /c hcloud ECS DeleteServers', 'deny'],
  ['cmd foo /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo cmd foo /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['bash -c "cmd foo /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /d C:\\Program Files /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /q /d C:\\Program Files /c hcloud ECS DeleteServers', 'deny'],
  ['cmd //d foo //c hcloud ECS DeleteServers', 'deny'],
  ['cmd /s foo /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /r hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command "&(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "&(\'hcloud.exe\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "&(\'C:\\hcloud.exe\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "& (\'hcloud\') ECS DeleteServers"', 'deny'],
  ['powershell -Command ".(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['cmd /c "&(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['cmd whatever /c "echo hi"', 'allow'],
  // The dot-call family's SPACED forms re-base with stray closers
  // dropped; the orphan argv-face gate keeps quoted package-name
  // arguments (`pip install "hcloud"`) and prose mentions unclassified
  // (TS/py aligned — the fallthrough classifies only argv and segment
  // calls now).
  ['powershell -Command ".( \'hcloud\' ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ". (\'hcloud\' ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ".( \'hcloud\') ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ".( \\"hcloud\\" ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } finally { .( \'hcloud\' ) ECS DeleteServers }"', 'deny'],
  ["docker stop 'hcloud'", 'allow'],
  ["docker restart 'hcloud'", 'allow'],
  ['pip install "hcloud"', 'allow'],
  ["npm uninstall 'hcloud'", 'allow'],
  ["kubectl delete cm 'hcloud'", 'allow'],
  ["helm delete 'hcloud'", 'allow'],
  ['see DeleteServers in the hcloud docs', 'allow'],
  ['docker stop hcloud', 'allow'],
  // Locator carve-out: `where hcloud` / `if exist hcloud` probe the bin's
  // presence (cmd builtins) — a bare bin with no argv is the probe shape.
  ['cmd /c "where hcloud"', 'allow'],
  ['cmd /c "if exist hcloud"', 'allow'],
  ['cmd /c "if defined hcloud"', 'allow'],
  ['powershell -Command "where hcloud"', 'allow'],
  // Deep nesting: adversarial `bash -c` nests five-plus deep genuinely
  // execute; the script recursion budget is 18 (one past the Linux
  // executability ceiling) so the separators stay live at every
  // executable depth. The depth-6 line is generator-produced (alternating
  // quote escapes) — regenerate rather than hand-edit.
  [
    'bash -c "bash -c \\"bash -c \\\\\\"bash -c \\\\\\\\\\\\\\"bash -c \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"bash -c \'hcloud x; hcloud ECS DeleteServers\'\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\"\\\\\\"\\""',
    'deny',
  ],
  // Escaped-dq inner quoting: the payload's `\"` pairs are span-internal
  // escapes — resolved on join, never double-edge-stripped — so the
  // canonical Windows quoting idiom classifies (writes deny, reads
  // allow).
  ['cmd /c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"hcloud ECS ListServers\\""', 'allow'],
  ['cmd /k "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /r "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['powershell -Command "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['pwsh -c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['sudo cmd /c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"sudo hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"env X=1 hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"hcloud ECS ListServers\\" x"', 'allow'],
  ['cmd /c "dir && bash -c \\"hcloud ECS ListServers\\""', 'allow'],
  // eval evaluates the JOIN of all its arguments — unquoted eval +
  // Windows wrapper runs the write; reads classify as reads. xargs
  // inside a quoted wrapper payload inherits the pipe (the child
  // executes the merged feeder). The `-Command=` spelling is not valid
  // PowerShell parameter syntax (colon only) — pinned allow.
  ['eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /k hcloud ECS DeleteServers', 'deny'],
  ['eval cmd //c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /c"hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell -Command "hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell hcloud ECS DeleteServers', 'deny'],
  ['eval powershell -NoProfile -Command "hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell -Command:"hcloud ECS DeleteServers"', 'deny'],
  ['eval pwsh -c hcloud ECS DeleteServers', 'deny'],
  ['eval C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /c start hcloud ECS DeleteServers', 'deny'],
  ['eval "cmd /c" hcloud ECS DeleteServers', 'deny'],
  ["eval 'cmd' '/c' 'hcloud ECS DeleteServers'", 'deny'],
  ['eval eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['sudo eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['timeout 5 eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['nohup eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['sh -c \'eval cmd /c "hcloud ECS DeleteServers"\'', 'deny'],
  ['bash -c eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['cmd /c "eval cmd /c hcloud ECS DeleteServers"', 'deny'],
  ['bash -c "eval cmd /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['eval hcloud ECS ListServers', 'allow'],
  ['eval "hcloud ECS ListServers"', 'allow'],
  ['eval hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['echo DeleteServers | cmd /c "xargs hcloud ECS"', 'deny'],
  ['echo DeleteServers | powershell -Command "xargs hcloud ECS"', 'deny'],
  ['echo rm | cmd /c "xargs hcloud OBS"', 'deny'],
  ['echo ListServers | cmd /c "xargs hcloud ECS"', 'allow'],
  ['powershell -Command="hcloud ECS DeleteServers"', 'allow'],
  // The `start` title-vs-child heuristic is quoting-blind: both the
  // title-shaped write and the notepad-arg mention deny — the fail-closed
  // cost pinned deliberately (same family as the echo-mention residual).
  ['cmd /c start notepad hcloud ECS DeleteServers', 'deny'],
  ['cmd /c start "hcloud ECS DeleteServers" notepad', 'deny'],
  // Documented residual: encoded payloads are opaque to a text gate
  // (same class as ssh-relayed commands); pinned here so the residual
  // stays a decision, not an accident.
  ['powershell -EncodedCommand aGNsb3VkIEVDUyBEZWxldGVTZXJ2ZXJzIC0tc2VydmVyLmlkPTE=', 'allow'],
  // Unquoted bash -c truncates to the bare bin (real bash semantics);
  // the empty-args fail-closed must agree across layers, including the
  // nested bare-hcloud shape (routing threads top-down in both layers).
  ['bash -c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["bash -c 'echo; hcloud' && echo done", 'deny'],
  ['hcloud', 'allow'],
  ['sudo hcloud', 'allow'],
  ['hcloud --', 'allow'],
];

test('TS classifier and python hook agree on the shared adversarial battery', () => {
  const mismatches: string[] = [];
  for (const [command, expected] of BATTERY) {
    const ts = classifyTextCommand(command).decision;
    if (ts !== expected) mismatches.push(`TS: want ${expected}, got ${ts}: ${command}`);
    const py = spawnSync('python3', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 30000,
    });
    const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (unavailable) continue; // python3 not on PATH: TS-only environment
    // A crashed hook must fail loudly, not read as "allow" through empty
    // stdout — an allow-expected entry that crashes would otherwise pass
    // silently (the exact shape that hid a TypeError during development).
    if (py.status !== 0 || py.stderr) {
      mismatches.push(`PY: crashed (status ${py.status}): ${command}: ${py.stderr.slice(0, 200)}`);
      continue;
    }
    const pyVerdict = py.stdout.trim().length > 0 ? 'deny' : 'allow';
    if (pyVerdict !== expected) mismatches.push(`PY: want ${expected}, got ${pyVerdict}: ${command}`);
  }
  assert.deepEqual(mismatches, [], 'layer drift detected');
});

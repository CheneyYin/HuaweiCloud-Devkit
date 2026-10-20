# Security Audit Guide

Phase-6 security audit procedure for the huawei-cloud-smn-dms-message skill. An agent runs the five gates
below itself (do NOT invoke another named Skill's scripts). Fix every **ERROR**/**CRITICAL**
finding and re-run until the gate passes. WARNING-only results require explicit user acceptance.

## Gate 1 — Secret leak detection (gitleaks, own scan)

```bash
gitleaks detect --source . --no-git --no-banner 2>/dev/null || true
```

Manual scan patterns on this skill:

```bash
grep -RniE "access[_-]?key\s*[:=]\s*['\"]?[A-Z0-9]{16,}|secret[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9/+]{16,}" SKILL.md references scripts
grep -RniE "hcloud configure (set|--cli-access-key)" SKILL.md references scripts
grep -RniE "HUAWEI.*(AK|SK|ACCESS|SECRET)=[A-Za-z0-9]" SKILL.md references scripts
```

Any hit that is not an explicit "prohibited/false-positive" annotation → fail.

## Gate 2 — Vulnerability / injection patterns

```bash
grep -RniE "os\.system|subprocess\.(call|run).*shell=True|eval\(|exec\(|pickle\.loads|\brm -rf /|\bcurl.*\|\s*sh|base64.*-d.*\|\s*sh" scripts/
```

`scripts/cli/cli_entry.py` (the shipped whitelist wrapper) runs `subprocess.run` with an **argument list** (no `shell=True`) — safe; the corpus script executor does not ship.
Prompt-injection markers (instruction-override phrases, fake `SYSTEM:` tags, role-play jailbreaks, etc.) must be absent from every prompt, template, and script.

## Gate 3 — Dependency security

This skill depends only on the standard Python library and the external `hcloud` binary
(no pip packages). If any pip dependency is added later:

```bash
pip-audit 2>/dev/null || pip install pip-audit && pip-audit
```

## Gate 4 — Insecure configuration

- No plaintext credential persistence: authentication uses the standard `hcloud` CLI configuration; the skill itself never stores credentials.
- `scripts/cli/cli_entry.py` invokes `subprocess.run` with an **argument list**, passthrough stdio (nothing captured — nothing is reported), whitelist + charset validation.
- No weak-password defaults injected into the DMS create operations (`CreatePostPaidKafkaInstance` / `CreatePostPaidInstanceByEngine` / `CreateInstanceByEngine`); RabbitMQ `--password` must always
  be user-supplied and never a literal placeholder.

## Gate 5 — Huawei Cloud Skill Specification compliance

Structural compliance is enforced by this repo's own gates — run them instead of
main's skill-creator validator path (which does not exist here):

```bash
npm run build && node --test test/structure.test.ts   # structure + adopted-skill doctrine guards
npm run validate                                        # packaging, pairing, boundaries
```

Recheck: SKILL.md sections, ≤500 lines, ≤30 files, ≤40 MB, allowlisted extensions,
`references/iam-policies.md`, `references/cli-installation-guide.md`, kebab-case reference names,
no cross-skill references, no credential hardcoding.

## Report format

Record in `phase-6-summary.json`:

```json
{
  "gitleaks": "clean",
  "vulnerability_scan": "clean",
  "dependency_audit": "clean (stdlib + hcloud only)",
  "config_scan": "clean",
  "spec_validation": "passed (N pass / M fail / K warn)",
  "accepted_warnings": []
}
```

#!/usr/bin/env python3
"""PreToolUse hook for Huawei Cloud agent safety.

Blocks the highest-risk leakage paths before an agent tool runs:
- reading local Huawei Cloud credential files
- dumping cloud credential environment variables
- directly retrieving cloud secret values
- running unapproved write operations through hcloud

The MCP server carries the same policy in Node for platforms that do not support
plugin hooks.
"""

import json
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

DENY_PREFIX = "Huawei Cloud safety hook blocked this action: "
RULES_PATH = Path(__file__).resolve().parents[1] / "safety" / "rules" / "cloud-risk-rules.json"
POLICY_PATH = Path(__file__).resolve().parents[1] / "safety" / "policy.json"

PLUGIN_DIR = Path(__file__).resolve().parents[2]
TELEMETRY_DIR = PLUGIN_DIR / "telemetry"
HOOK_EVENTS_PATH = TELEMETRY_DIR / "hook-events.jsonl"

CONFIG_FILE_RE = None
SECRET_READ_RE = None
WRITE_OPERATION_RE = None
AGENTARTS_POLICY = None


def load_policy():
    global CONFIG_FILE_RE, SECRET_READ_RE, WRITE_OPERATION_RE, AGENTARTS_POLICY
    try:
        with POLICY_PATH.open("r", encoding="utf-8") as file_obj:
            policy = json.load(file_obj)
        cred_patterns = policy.get("credentialFilePatterns", [])
        if cred_patterns:
            CONFIG_FILE_RE = re.compile("|".join(cred_patterns), re.I)
        blocked_secrets = policy.get("blockedSecretOperations", [])
        if blocked_secrets:
            SECRET_READ_RE = re.compile("|".join(re.escape(op) for op in blocked_secrets), re.I)
        write_prefixes = policy.get("writeOperationPrefixes", [])
        if write_prefixes:
            WRITE_OPERATION_RE = re.compile(r"(^|[A-Za-z0-9])(" + "|".join(write_prefixes) + r")\w*", re.I)
        AGENTARTS_POLICY = policy.get("agentartsCommandPolicy")
    except Exception:
        pass


load_policy()

ENV_DUMP_RE = re.compile(
    r"(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:).*(HUAWEICLOUD|HWC_|HCLOUD|HW_|OS_)", re.I,
)
# Credential variable references bypass the env-command gate above: HW_ is
# the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
# HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
# HUAWEICLOUD_SECRET_ACCESS_KEY name, and `echo $HW_SECRET_KEY` /
# `printenv HW_ACCESS_KEY` / `echo $HUAWEICLOUD_SECRET_ACCESS_KEY` previously
# fell through to allow (#561 D4-2, #770 D4-2).
#
# The negative lookbehind exempts literal-NAME references — backslash-escaped
# (\$HW_*) or single-quoted ('$HW_*', which the shell never expands) —
# while unescaped `$HW_*` is a potential expansion/dump regardless of the
# command. Aligned with safety-policy.mjs L419-423.
CRED_VAR_REF_RE = re.compile(
    r"(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK)"
    r"|(?:^|\s)printenv\s+(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK)",
    re.I,
)
HCLOUD_RE = re.compile(r"(^|\s)hcloud(\.exe)?\s+", re.I)
READ_OPERATION_RE = re.compile(r"\b(List|Show|Get|Describe|NovaList|NovaShow)\w*", re.I)

# AgentArts CLI (agentarts-sdk) keyword locator — command-position semantics
# aligned with safety-policy.mjs: plain mid-text mentions do not match;
# separators, command substitution, sudo, and line starts do. Tiers come from
# policy.json agentartsCommandPolicy (measured facts, see
# docs/agentarts-pr0-findings.md) so both hooks and the approval wrapper
# consume one source.
AGENTARTS_KEYWORD_RE = re.compile(
    r"(?:^|[;|&]\s*|\$\(\s*|`\s*|sudo\s+|\r?\n\s*)(agentarts(?:\.exe)?\b)",
    re.I | re.M,
)


def _agentarts_tokens(rest):
    # Mirror splitSimpleCommand: keep quoted segments whole, then strip ALL
    # quote characters so embedded-quote keywords/tokens still classify
    # (#927 shape).
    parts = re.findall(r'"[^"]*"|\'[^\']*\'|\S+', rest)
    return [part.replace("'", "").replace('"', "") for part in parts]


def _inner_command_candidates(text):
    # Minimal mirror of extractInnerCommand for the agentarts gate: pull the
    # payload out of `bash -c "…"`, `eval '…'`, `$(…)`, and backticks so a
    # wrapped write command classifies. Plain quoted natural language
    # (`echo "agentarts is a CLI"`) does not match any wrapper shape.
    candidates = [text]
    wrappers = (
        r"\b(?:bash|sh|zsh|dash|\/bin\/(?:bash|sh|zsh|dash)|bash\.exe|sh\.exe)\s+-c\s+(\"[^\"]*\"|'[^']*')",
        r"\beval\s+(\"[^\"]*\"|'[^']*')",
        r"\$\(([^)]+)\)",
        r"`([^`]+)`",
    )
    for pattern in wrappers:
        for m in re.finditer(pattern, text, re.I):
            inner = m.group(1)
            candidates.append(inner.strip("\"'"))
    return candidates


def agentarts_block_reason(text):
    """Classify an `agentarts …` command against agentartsCommandPolicy.

    Returns a block reason for approved/blocked tiers, None for
    local/readonly. Fails safe: an unresolvable group/subcommand classifies
    as the policy defaultTier (approved), and a missing policy denies any
    agentarts command rather than allowing it unclassified.
    """
    for candidate in _inner_command_candidates(text):
        reason = _agentarts_block_reason_single(candidate)
        if reason:
            return reason
    return None


def _agentarts_block_reason_single(text):
    m = AGENTARTS_KEYWORD_RE.search(text)
    if not m:
        # Quote-embedded keyword retry (de-quoted copy, keyword location only).
        stripped = re.sub(r"['\"]", "", text)
        m = AGENTARTS_KEYWORD_RE.search(stripped)
        if not m:
            return None
        rest = stripped[m.end(1):]
    else:
        rest = text[m.end(1):]
    tokens = [t.lower() for t in _agentarts_tokens(rest)]
    i = 0
    while i < len(tokens) and tokens[i].startswith("-"):
        i += 1
    if i >= len(tokens) or any(t in ("--help", "-h") for t in tokens[i:]):
        return None
    if AGENTARTS_POLICY is None:
        return "agentarts safety policy is unavailable; agentarts commands are blocked until the policy loads."
    group = tokens[i]
    aliases = AGENTARTS_POLICY.get("aliases", {})
    commands = AGENTARTS_POLICY.get("commands", {})
    default_tier = AGENTARTS_POLICY.get("defaultTier", "approved")
    normalized = aliases.get(group, group)
    entry = commands.get(normalized)
    tier = default_tier
    labels = []
    op = normalized
    if entry:
        tier = entry.get("tier", default_tier)
        labels = entry.get("labels", [])
        subs = entry.get("subcommands")
        if subs and i + 1 < len(tokens) and not tokens[i + 1].startswith("-"):
            sub_entry = subs.get(tokens[i + 1])
            if sub_entry:
                tier = sub_entry.get("tier", tier)
                labels = sub_entry.get("labels", labels)
                op = f"{normalized} {tokens[i + 1]}"
    if tier not in ("approved", "blocked"):
        return None
    label_text = ", ".join(labels) if labels else "cloud write"
    if tier == "blocked":
        return (
            f"agentarts {op} is deferred to a later toolkit release; run it in your own terminal if needed "
            "(see the huawei-agentarts skill)."
        )
    return (
        f"agentarts {op} is a cloud write operation ({label_text}). Run it in your own terminal, or use the "
        "approved agentarts tooling (see the huawei-agentarts skill)."
    )


def deny(reason, hermes=False):
    sys.stdout.write(
        json.dumps(
            {
                "action": "block",
                "message": DENY_PREFIX + reason,
            }
            if hermes
            else {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": DENY_PREFIX + reason,
                }
            }
        )
        + "\n"
    )
    sys.exit(0)


def allow():
    sys.exit(0)


def record_cli_event(text):
    m = HCLOUD_RE.search(text)
    if not m:
        return
    rest = text[m.end():].strip()
    parts = rest.split()
    cmd = " ".join(p for p in parts if not p.startswith("--") and not p.startswith("-") and "=" not in p)
    if not cmd:
        return
    is_read = bool(READ_OPERATION_RE.search(cmd))
    is_write = bool(WRITE_OPERATION_RE.search(cmd)) if WRITE_OPERATION_RE else False
    event_key = "cli:read" if is_read else ("cli:write" if is_write else "cli:invoke")
    event = {"key": event_key, "value": f"hcloud {cmd}", "capability": "cli"}
    try:
        TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)
        with HOOK_EVENTS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass


def command_text(tool_input):
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        values = []
        for key in ("command", "cmd", "script", "args", "arguments"):
            value = tool_input.get(key)
            if isinstance(value, list):
                values.append(" ".join(str(item) for item in value))
            elif value is not None:
                values.append(str(value))
        if values:
            return "\n".join(values)
        return json.dumps(tool_input)
    return json.dumps(tool_input)


def load_cloud_risk_rules():
    try:
        with RULES_PATH.open("r", encoding="utf-8") as file_obj:
            catalog = json.load(file_obj)
        return catalog.get("rules", [])
    except Exception:
        return []


def condition_matches(condition, text):
    return re.search(condition.get("regex", r"a^"), text, re.I | re.M | re.S) is not None


def rule_matches(rule, text):
    match = rule.get("match") or {}
    all_conditions = match.get("all")
    any_conditions = match.get("any")
    none_conditions = match.get("none")

    if isinstance(all_conditions, list):
        for condition in all_conditions:
            if not condition_matches(condition, text):
                return False
    if isinstance(any_conditions, list):
        if not any(condition_matches(condition, text) for condition in any_conditions):
            return False
    if isinstance(none_conditions, list):
        if any(condition_matches(condition, text) for condition in none_conditions):
            return False
    return isinstance(all_conditions, list) or isinstance(any_conditions, list)


def first_denied_command_rule(text):
    for rule in load_cloud_risk_rules():
        if "command" not in rule.get("stages", []):
            continue
        if rule.get("severity") != "deny":
            continue
        if rule_matches(rule, text):
            return rule
    return None


def evaluate(tool_name, tool_input):
    """Run the full safety check and return a raw block reason, or None to allow.

    Shared by the CLI shell (``main``) and the Hermes Python-plugin hook, which
    reuses this module via ``importlib`` so a single implementation enforces the
    policy everywhere. The returned reason does NOT include ``DENY_PREFIX`` —
    callers decide the exact output shape.
    """
    text = command_text(tool_input)

    if CONFIG_FILE_RE and CONFIG_FILE_RE.search(text):
        return "reading Huawei Cloud credential/profile files can expose AK/SK or tokens. Use redacted toolkit tools."
    if ENV_DUMP_RE.search(text):
        return "dumping cloud credential environment variables is not allowed."
    if CRED_VAR_REF_RE.search(text):
        return "printing cloud credential environment variables is not allowed."
    if SECRET_READ_RE and SECRET_READ_RE.search(text):
        return "direct secret value retrieval would put plaintext secrets into the agent context."
    denied_rule = first_denied_command_rule(text)
    if denied_rule:
        return f"{denied_rule.get('message')} Remediation: {denied_rule.get('remediation')}"
    if tool_name in ("Bash", "terminal") and HCLOUD_RE.search(text) and WRITE_OPERATION_RE.search(text) and not READ_OPERATION_RE.search(text):
        return "unapproved Huawei Cloud write operations must be planned first and explicitly approved by the user."
    if tool_name in ("Bash", "terminal"):
        agentarts_reason = agentarts_block_reason(text)
        if agentarts_reason:
            return agentarts_reason

    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        allow()

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    hermes = "hook_event_name" in data

    text = command_text(tool_input)
    record_cli_event(text)

    reason = evaluate(tool_name, tool_input)
    if reason:
        deny(reason, hermes)

    allow()


if __name__ == "__main__":
    main()

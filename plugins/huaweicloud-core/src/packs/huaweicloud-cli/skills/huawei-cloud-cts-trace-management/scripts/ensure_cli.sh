#!/bin/bash
set -euo pipefail
# ensure_cli.sh — availability check + manual hint (normalized v2 form).
# The wrapper is OPTIONAL: when absent, this skill's hcloud commands run
# bare with identical semantics. This script performs NO deployment, NO
# PATH persistence, NO network access, and NO symlinks — it only reports
# availability, distinguishes the normalized v2 wrapper from a foreign
# (e.g. v1 telemetry-bearing) install, and prints the manual fallback.

probe() {
  local bin="$1"
  local out
  if out="$("$bin" version 2>/dev/null)"; then
    if echo "$out" | grep -q "no telemetry"; then
      echo "skill-quality-cli ready (normalized v2 form): ${bin}"
      exit 0
    fi
    echo "skill-quality-cli found but NOT the normalized v2 form (no 'no telemetry' marker in version output): ${bin}" >&2
    echo "A foreign/v1 wrapper may carry telemetry — run this skill's hcloud commands bare (identical semantics), or redeploy scripts/cli/cli_entry.py per the manual hint below." >&2
    exit 0
  fi
  return 1
}

CLI_BIN="$(command -v skill-quality-cli 2>/dev/null || true)"
if [ -n "$CLI_BIN" ] && probe "$CLI_BIN"; then
  :
fi

if [ -x "$HOME/.local/bin/skill-quality-cli" ] && probe "$HOME/.local/bin/skill-quality-cli"; then
  :
fi

echo "skill-quality-cli not installed — OPTIONAL; this skill's hcloud commands run bare with identical semantics." >&2
echo "Manual local deployment (offline, no download): copy scripts/cli/cli_entry.py to ~/.local/bin/skill-quality-cli.d/ and create a wrapper script ~/.local/bin/skill-quality-cli executing: python3 ~/.local/bin/skill-quality-cli.d/cli_entry.py \"\$@\"" >&2
exit 0

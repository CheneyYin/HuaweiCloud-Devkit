#!/bin/bash
set -euo pipefail
# ensure_cli.sh — availability check + manual hint (normalized v2 form).
# The wrapper is OPTIONAL: when absent, this skill's hcloud commands run
# bare with identical semantics. This script performs NO deployment, NO
# PATH persistence, NO network access, and NO symlinks — it only reports
# availability and the manual fallback.

CLI_BIN="$(command -v skill-quality-cli 2>/dev/null || true)"
if [ -n "$CLI_BIN" ] && "$CLI_BIN" version >/dev/null 2>&1; then
  echo "skill-quality-cli ready: ${CLI_BIN}"
  exit 0
fi

if [ -x "$HOME/.local/bin/skill-quality-cli" ] && "$HOME/.local/bin/skill-quality-cli" version >/dev/null 2>&1; then
  echo "skill-quality-cli ready: $HOME/.local/bin/skill-quality-cli (not on PATH — run with the absolute path or: export PATH=\"\$HOME/.local/bin:\$PATH\")"
  exit 0
fi

echo "skill-quality-cli not installed — OPTIONAL; this skill's hcloud commands run bare with identical semantics." >&2
echo "Manual local deployment (offline, no download): copy scripts/cli/cli_entry.py to ~/.local/bin/skill-quality-cli.d/ and create a wrapper script ~/.local/bin/skill-quality-cli executing: python3 ~/.local/bin/skill-quality-cli.d/cli_entry.py \"\$@\"" >&2
exit 0

#!/usr/bin/env python3
"""skill-quality-cli — local command wrapper for the huawei-cloud-* skills.

Normalized v2 form (supply-chain ruling): the wrapper is an OPTIONAL local
convenience only —
  - no telemetry: nothing is uploaded anywhere; there is no reporting code
    and no endpoint contact of any kind
  - no network: no install/upgrade/bootstrap downloads; this file never
    opens a socket
  - whitelist: `run` may only wrap `hcloud` with a restricted argument
    charset (the devkit's safety layer additionally unwraps this wrapper,
    so an embedded hcloud write keeps its approval gate either way)
  - optional: when the wrapper is absent, the skill's hcloud commands run
    bare with identical semantics
Commands: version / run / self-check
"""

import argparse
import os
import subprocess
import sys

CLI_VERSION = "2.0.0-local"

# TM1 tool-argument validation: run may only wrap whitelisted commands.
ALLOWED_COMMANDS = ("hcloud",)
_ALLOWED_ARG_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.=/:,{}@"
)


def _reject(message):
    print("skill-quality-cli: %s" % message, file=sys.stderr)
    sys.exit(2)


def _validate_command(command):
    if not command:
        _reject("no command to run (usage: run [--skill-name NAME] -- <command>)")
    base = os.path.basename(command[0])
    if base not in ALLOWED_COMMANDS:
        _reject("command not allowed by the wrapper whitelist: %s" % base)
    for arg in command[1:]:
        for ch in arg:
            if ch not in _ALLOWED_ARG_CHARS:
                _reject("argument contains characters outside the wrapper charset: %r" % arg)


def cmd_version(_args):
    print("skill-quality-cli %s (local wrapper; no telemetry, no network)" % CLI_VERSION)
    return 0


def cmd_run(args):
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    _validate_command(command)
    # Passthrough stdio: the child's output belongs to the caller —
    # nothing is captured because nothing is reported.
    proc = subprocess.run(command)
    return proc.returncode


def cmd_self_check(_args):
    # Local sanity only: whitelist configured, no network paths compiled in.
    print("whitelist: %s" % ",".join(ALLOWED_COMMANDS))
    print("network: none (no downloads, no reporting, no endpoints)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="skill-quality-cli",
        description="Optional local hcloud wrapper (no telemetry, no network)",
    )
    sub = parser.add_subparsers(dest="subcommand")

    sub.add_parser("version", help="print the wrapper version")

    p_run = sub.add_parser("run", help="run a whitelisted command")
    p_run.add_argument("--skill-name", default="")
    p_run.add_argument("--session-id", default="")
    p_run.add_argument("--json", default=None)
    p_run.add_argument("command", nargs=argparse.REMAINDER, help="the command to run")

    sub.add_parser("self-check", help="print the local sanity summary")

    args = parser.parse_args(argv)
    if args.subcommand == "version":
        return cmd_version(args)
    if args.subcommand == "run":
        return cmd_run(args)
    if args.subcommand == "self-check":
        return cmd_self_check(args)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())

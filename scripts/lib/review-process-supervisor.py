#!/usr/bin/env python3
"""Run one review command in its own session and own every descendant."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


def write_identity(path: Path, value: int) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(f"{value}\n", encoding="utf-8")
    os.replace(temporary, path)


def group_alive(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def signal_group(process_group: Optional[int], sig: signal.Signals) -> None:
    if process_group is None:
        return
    try:
        os.killpg(process_group, sig)
    except ProcessLookupError:
        pass


def wait_for_group_exit(
    child: subprocess.Popen, process_group: int, timeout: float
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        child.poll()
        if not group_alive(process_group):
            return True
        time.sleep(0.02)
    child.poll()
    return not group_alive(process_group)


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[1] != "--control-dir" or sys.argv[3] != "--":
        print(
            "usage: review-process-supervisor.py --control-dir DIR -- COMMAND [ARG...]",
            file=sys.stderr,
        )
        return 2

    control_dir = Path(sys.argv[2])
    command = sys.argv[4:]
    if not command:
        print("review supervisor requires a command", file=sys.stderr)
        return 2

    control_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    requested_signal: Optional[signal.Signals] = None
    process_group: Optional[int] = None

    def request_shutdown(signum: int, _frame: object) -> None:
        nonlocal requested_signal
        requested_signal = signal.Signals(signum)
        signal_group(process_group, signal.SIGTERM)

    for handled in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(handled, request_shutdown)

    # Publish supervisor ownership before any optional delay or child spawn.
    # The parent trap can therefore find and stop us even if its signal lands
    # between the shell's asynchronous launch and `$!` assignment.
    write_identity(control_dir / "supervisor.pid", os.getpid())

    delay = float(os.environ.get("REVIEW_SUPERVISOR_START_DELAY_SECONDS", "0"))
    if delay > 0:
        deadline = time.monotonic() + delay
        while requested_signal is None and time.monotonic() < deadline:
            time.sleep(max(0, min(0.02, deadline - time.monotonic())))
    if requested_signal is not None:
        return 128 + requested_signal.value

    child = subprocess.Popen(command, start_new_session=True, close_fds=True)
    process_group = child.pid
    write_identity(control_dir / "process-group.pid", process_group)

    if requested_signal is not None:
        signal_group(process_group, signal.SIGTERM)

    while child.poll() is None and requested_signal is None:
        time.sleep(0.02)

    child_exit = child.poll()
    grace = float(os.environ.get("REVIEW_PROCESS_TERM_GRACE_SECONDS", "2"))

    # A command may exit while leaving workers behind, or a TERM handler may
    # fork one last cleanup child after the first group signal. Keep supervising
    # the session until it is empty; escalate only after the grace period.
    if group_alive(process_group):
        signal_group(process_group, signal.SIGTERM)
        if not wait_for_group_exit(child, process_group, grace):
            signal_group(process_group, signal.SIGKILL)
            while not wait_for_group_exit(child, process_group, 0.5):
                signal_group(process_group, signal.SIGKILL)

    if child_exit is None:
        child_exit = child.wait()

    if requested_signal is not None:
        return 128 + requested_signal.value
    if child_exit < 0:
        return 128 - child_exit
    return child_exit


if __name__ == "__main__":
    raise SystemExit(main())

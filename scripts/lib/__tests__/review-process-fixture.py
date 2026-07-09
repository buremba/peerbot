#!/usr/bin/env python3
"""Process-tree fixtures for the review supervisor shell tests."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def late_grandchild(ready_path: Path, late_pid_path: Path) -> None:
    def terminate(_signum: int, _frame: object) -> None:
        child = subprocess.Popen(["sleep", "30"], close_fds=True)
        late_pid_path.write_text(f"{child.pid}\n", encoding="utf-8")
        while True:
            time.sleep(1)

    signal.signal(signal.SIGTERM, terminate)
    ready_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    while True:
        time.sleep(1)


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] != "late-grandchild":
        print(
            "usage: review-process-fixture.py late-grandchild READY LATE_PID",
            file=sys.stderr,
        )
        return 2
    late_grandchild(Path(sys.argv[2]), Path(sys.argv[3]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

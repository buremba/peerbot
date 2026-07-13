#!/usr/bin/env python3
"""Render Codex --json event lines as short human progress for a Herdr pane.

Keeps --output-last-message as the structured verdict path; this script only
makes the review tab watchable. Unknown event shapes pass through lightly.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _truncate(text: str, limit: int = 240) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _item_line(item: dict[str, Any]) -> str | None:
    item_type = item.get("type") or "item"
    if item_type == "agent_message":
        text = item.get("text") or item.get("message") or ""
        if not text:
            return None
        return f"assistant: {_truncate(str(text), 400)}"
    if item_type in {"command_execution", "command", "shell"}:
        cmd = item.get("command") or item.get("cmd") or item.get("text") or ""
        status = item["status"] if "status" in item else item.get("exit_code")
        suffix = f" → {status}" if status is not None else ""
        return f"shell: {_truncate(str(cmd))}{suffix}"
    if item_type in {"file_change", "patch", "apply_patch"}:
        path = item.get("path") or item.get("file") or ""
        return f"edit: {_truncate(str(path) or item_type)}"
    if item_type in {"mcp_tool_call", "tool_call", "function_call"}:
        name = item.get("name") or item.get("tool") or item.get("server") or item_type
        return f"tool: {_truncate(str(name))}"
    # Generic fallback — show type so the pane is never silent mid-run.
    summary = item.get("text") or item.get("message") or item.get("summary") or ""
    if summary:
        return f"{item_type}: {_truncate(str(summary))}"
    return f"{item_type}"


def _format_event(event: dict[str, Any]) -> str | None:
    typ = event.get("type") or ""
    if typ == "thread.started":
        tid = event.get("thread_id") or ""
        return f"codex: thread started{f' ({tid})' if tid else ''}"
    if typ == "turn.started":
        return "codex: turn started"
    if typ == "turn.completed":
        usage = event.get("usage") or {}
        parts = []
        for key in ("input_tokens", "output_tokens"):
            if key in usage:
                parts.append(f"{key}={usage[key]}")
        extra = f" ({', '.join(parts)})" if parts else ""
        return f"codex: turn completed{extra}"
    if typ == "turn.failed":
        err = event.get("error") or event.get("message") or event
        return f"codex: turn failed: {_truncate(str(err))}"
    if typ in {"item.started", "item.updated", "item.completed"}:
        item = event.get("item")
        if isinstance(item, dict):
            line = _item_line(item)
            if line:
                prefix = "…" if typ == "item.updated" else "•"
                return f"{prefix} {line}"
        return None
    if typ in {"error", "thread.failed"}:
        err = event.get("message") or event.get("error") or event
        return f"codex: error: {_truncate(str(err))}"
    # Ignore high-volume / low-signal noise.
    if typ in {"token_count", "thread.token_usage", "rate_limits"}:
        return None
    return None


def main() -> int:
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print(line, flush=True)
            continue
        if not isinstance(event, dict):
            print(line, flush=True)
            continue
        rendered = _format_event(event)
        if rendered:
            print(rendered, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

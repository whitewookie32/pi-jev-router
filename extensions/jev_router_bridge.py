"""Secret-free stdin/stdout bridge to Hermes's shared JEV turn router."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _fail_open(reason: str) -> None:
    print(json.dumps({"status": "failed-open", "reason": reason}), flush=True)


def main() -> None:
    try:
        request: Any = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise ValueError("invalid-request")
        source = Path(str(os.environ.get("HERMES_AGENT_SOURCE") or "")).resolve()
        if not source.is_dir():
            raise ValueError("missing-hermes-source")
        sys.path.insert(0, str(source))
        import hermes_bootstrap  # noqa: F401 - installs Hermes's managed dependencies.
        from agent.jev_routing import jev_decision_metadata, resolve_jev_turn_route

        message = request.get("message")
        locked_reason = request.get("locked_reason")
        decision = resolve_jev_turn_route(
            message if isinstance(message, str) else "",
            platform="pi",
            locked_reason=locked_reason if isinstance(locked_reason, str) else "",
        )
        print(json.dumps(jev_decision_metadata(decision), separators=(",", ":")), flush=True)
    except Exception:
        _fail_open("bridge-error")


if __name__ == "__main__":
    main()

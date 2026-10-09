"""Append-only JSONL evidence log. One line per event, never overwritten.

Every event must be reproducible: it always carries run_id, seed and
corpus_sha256, plus whatever model IDs are relevant to that event.
"""
import json
import os

REQUIRED_KEYS = ("run_id", "seed", "corpus_sha256")


def append_event(path: str, event: dict) -> None:
    """Append one event as a single JSON line to path, creating parent dirs if needed.

    Raises ValueError if run_id, seed or corpus_sha256 is missing, so a bug
    can never silently produce an unreproducible evidence file.
    """
    missing = [k for k in REQUIRED_KEYS if k not in event]
    if missing:
        raise ValueError(f"evidence event missing required keys: {missing}")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")

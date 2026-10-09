"""Sqlite-backed cache for model calls, keyed by (model, messages, temperature, sample_idx).

sample_idx keeps repeat samples distinct and replayable: calling the same payload
with sample_idx=0..4 gives five independently-cacheable "repeat" verdicts instead
of one cached answer reused five times.
"""
import hashlib
import json
import sqlite3
from pathlib import Path

DEFAULT_PATH = Path(".cache/llm.sqlite")


def key_for(model: str, messages: list[dict], temperature: float, sample_idx: int) -> str:
    """Stable sha256 key. Canonical JSON so key order never changes the hash."""
    payload = json.dumps(
        {"model": model, "messages": messages, "temperature": temperature, "sample_idx": sample_idx},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SqliteCache:
    """A tiny key->text cache. One row per (model, messages, temperature, sample_idx)."""

    def __init__(self, path: Path = DEFAULT_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path)
        self._conn.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT)")
        self._conn.commit()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM cache WHERE key = ?", (key,)).fetchone()
        if row is None:
            self.misses += 1
            return None
        self.hits += 1
        return row[0]

    def set(self, key: str, value: str) -> None:
        self._conn.execute("INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)", (key, value))
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

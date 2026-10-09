"""The one model client. Every model call in this project goes through complete().

Provider: NVIDIA NIM, OpenAI-compatible, base_url https://integrate.api.nvidia.com/v1.
Key: NIM_API_KEY from .env. Never print, log or commit it.
"""
import os
import time
from pathlib import Path

from llm.cache import SqliteCache, key_for

BASE_URL = "https://integrate.api.nvidia.com/v1"
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 5

_default_cache: SqliteCache | None = None


def get_default_cache() -> SqliteCache:
    global _default_cache
    if _default_cache is None:
        _default_cache = SqliteCache()
    return _default_cache


class RateLimiter:
    """Sliding-window limiter: blocks until fewer than `rpm` calls happened in the last 60s."""

    def __init__(self, rpm: int = 35):
        self.rpm = rpm
        self._timestamps: list[float] = []

    def wait(self) -> None:
        now = time.monotonic()
        self._timestamps = [t for t in self._timestamps if now - t < 60]
        if len(self._timestamps) >= self.rpm:
            sleep_for = 60 - (now - self._timestamps[0])
            if sleep_for > 0:
                time.sleep(sleep_for)
        self._timestamps.append(time.monotonic())


_default_limiter = RateLimiter()


def _load_dotenv(path: str = ".env") -> None:
    """Tiny .env loader so NIM_API_KEY doesn't need to be manually exported.
    No new dependency: plain key=value lines, comments and blanks skipped."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


def _real_transport(model: str, messages: list[dict], temperature: float, max_tokens: int) -> str:
    """Constructs the real OpenAI-compatible client lazily, so importing this module
    (or running tests with a fake transport) never requires NIM_API_KEY to be set."""
    import openai

    _load_dotenv()
    client = openai.OpenAI(base_url=BASE_URL, api_key=os.environ["NIM_API_KEY"])
    resp = client.chat.completions.create(
        model=model, messages=messages, temperature=temperature, max_tokens=max_tokens
    )
    return resp.choices[0].message.content or ""


def complete(
    model: str,
    messages: list[dict],
    temperature: float = 0.0,
    sample_idx: int = 0,
    max_tokens: int = 512,
    *,
    cache: SqliteCache | None = None,
    transport=None,
    limiter: RateLimiter | None = None,
) -> str:
    """Return the model's text reply, served from cache when possible.

    transport(model, messages, temperature, max_tokens) -> str lets tests inject a
    fake instead of a real network call. Never call the real API in tests.
    """
    cache = cache if cache is not None else get_default_cache()
    limiter = limiter if limiter is not None else _default_limiter
    transport = transport if transport is not None else _real_transport

    key = key_for(model, messages, temperature, sample_idx)
    cached = cache.get(key)
    if cached is not None:
        return cached

    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            limiter.wait()
            result = transport(model, messages, temperature, max_tokens)
            cache.set(key, result)
            return result
        except Exception as exc:  # noqa: BLE001 -- broad on purpose, see status check below
            status = getattr(exc, "status_code", None)
            if status not in RETRYABLE_STATUS:
                raise
            last_exc = exc
            time.sleep(2**attempt)
    raise last_exc

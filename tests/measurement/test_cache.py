"""Cache tests. Never call the real API -- always inject a fake transport."""
import tempfile
from pathlib import Path

import pytest

from llm.cache import SqliteCache, key_for
from llm.client import RateLimiter, complete


def test_key_is_stable_regardless_of_dict_order():
    a = key_for("m", [{"role": "user", "content": "hi"}], 0.0, 0)
    b = key_for("m", [{"content": "hi", "role": "user"}], 0.0, 0)
    assert a == b


def test_key_changes_with_sample_idx():
    a = key_for("m", [{"role": "user", "content": "hi"}], 0.0, 0)
    b = key_for("m", [{"role": "user", "content": "hi"}], 0.0, 1)
    assert a != b


def test_sqlite_cache_roundtrip(tmp_path):
    cache = SqliteCache(tmp_path / "t.sqlite")
    key = key_for("m", [{"role": "user", "content": "hi"}], 0.0, 0)
    assert cache.get(key) is None
    cache.set(key, "hello")
    assert cache.get(key) == "hello"
    cache.close()


def test_repeated_call_served_from_cache_with_zero_network_calls(tmp_path):
    cache = SqliteCache(tmp_path / "t.sqlite")
    calls = {"n": 0}

    def fake_transport(model, messages, temperature, max_tokens):
        calls["n"] += 1
        return "real response"

    messages = [{"role": "user", "content": "attack payload"}]
    first = complete("m", messages, temperature=0.0, sample_idx=0, cache=cache, transport=fake_transport)
    second = complete("m", messages, temperature=0.0, sample_idx=0, cache=cache, transport=fake_transport)

    assert first == second == "real response"
    assert calls["n"] == 1, "second call must be served from cache, not the transport"


def test_different_sample_idx_are_independent_cache_entries(tmp_path):
    cache = SqliteCache(tmp_path / "t.sqlite")
    calls = {"n": 0}

    def fake_transport(model, messages, temperature, max_tokens):
        calls["n"] += 1
        return f"response {calls['n']}"

    messages = [{"role": "user", "content": "x"}]
    r0 = complete("m", messages, sample_idx=0, cache=cache, transport=fake_transport)
    r1 = complete("m", messages, sample_idx=1, cache=cache, transport=fake_transport)

    assert r0 != r1
    assert calls["n"] == 2


def test_retries_on_retryable_status_then_succeeds(tmp_path):
    cache = SqliteCache(tmp_path / "t.sqlite")
    attempts = {"n": 0}

    class FakeError(Exception):
        status_code = 429

    def flaky_transport(model, messages, temperature, max_tokens):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise FakeError("rate limited")
        return "ok after retries"

    # avoid real sleeping: pass a limiter whose wait() is a no-op, and the retry
    # backoff itself still sleeps briefly (2**0, 2**1 seconds); monkeypatch time.sleep.
    import llm.client as client_mod
    original_sleep = client_mod.time.sleep
    client_mod.time.sleep = lambda s: None
    try:
        result = complete(
            "m", [{"role": "user", "content": "x"}], cache=cache,
            transport=flaky_transport, limiter=RateLimiter(rpm=1000),
        )
    finally:
        client_mod.time.sleep = original_sleep

    assert result == "ok after retries"
    assert attempts["n"] == 3


def test_non_retryable_status_raises_immediately(tmp_path):
    cache = SqliteCache(tmp_path / "t.sqlite")
    attempts = {"n": 0}

    class FakeError(Exception):
        status_code = 400

    def bad_request_transport(model, messages, temperature, max_tokens):
        attempts["n"] += 1
        raise FakeError("bad request")

    with pytest.raises(FakeError):
        complete("m", [{"role": "user", "content": "x"}], cache=cache, transport=bad_request_transport)
    assert attempts["n"] == 1, "must not retry on a non-retryable status"

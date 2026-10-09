"""python -m llm.smoke -- calls each configured model once and prints latency.

Not a test (tests never call the real API). This is the manual, human-run check
that config/models.yaml's pinned IDs actually work right now.
"""
import time

import yaml

from llm.client import complete

PROMPT = [{"role": "user", "content": "Reply with exactly one word: OK"}]


def main() -> None:
    config = yaml.safe_load(open("config/models.yaml"))
    models = config["models"]
    cache = __import__("llm.cache", fromlist=["SqliteCache"]).SqliteCache()

    seen = set()
    for role, model_id in models.items():
        if model_id in seen:
            print(f"{role:10s} {model_id:45s} (same model as above, skipping duplicate call)")
            continue
        seen.add(model_id)
        t0 = time.time()
        reply = complete(model_id, PROMPT, temperature=0.0, sample_idx=0, cache=cache)
        dt = time.time() - t0
        print(f"{role:10s} {model_id:45s} {dt:5.2f}s  -> {reply!r}")

    print(f"\ncache: {cache.hits} hits, {cache.misses} misses this run")


if __name__ == "__main__":
    main()

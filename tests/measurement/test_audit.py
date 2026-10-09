"""Audit tests. SimJudge and fake transports only: never the real API, never the real corpus."""
import json

import pytest
import yaml

from core.sim_judge import SimJudge
from experiments import audit
from guard.monitor import Monitor
from llm.cache import SqliteCache

CFG = {"seed": 0, "repeats": 5, "model_b_samples": 2, "rewordings": 6}


def item(i, label, channel="web", category="direct_override"):
    return {"id": i, "channel": channel, "category": category, "label": label,
            "goal": "exfiltrate" if label == "malicious" else "none", "text": f"text number {i}"}


ITEMS = [item("a1", "malicious"), item("a2", "malicious", "email", "role_play"),
         item("b1", "benign", "web", "benign_lookalike"), item("b2", "benign", "email", "benign_lookalike")]


class CountingJudge(SimJudge):
    calls = 0

    def judge(self, content, sample_idx):
        type(self).calls += 1
        return super().judge(content, sample_idx)


def judges(p_a=1.0, p_b=1.0):
    return (SimJudge(p_a, 1), SimJudge(p_a, 2), SimJudge(p_b, 3))


def write_corpus(tmp_path):
    d = tmp_path / "corpus"
    d.mkdir()
    (d / "attacks.yaml").write_text(yaml.safe_dump([i for i in ITEMS if i["label"] == "malicious"]))
    (d / "benign.yaml").write_text(yaml.safe_dump({"items": [i for i in ITEMS if i["label"] == "benign"]}))
    return d


def test_load_corpus_hash_is_stable_and_changes_with_content(tmp_path):
    d = write_corpus(tmp_path)
    items, sha1 = audit.load_corpus(d)
    assert len(items) == 4 and len(sha1) == 64
    assert audit.load_corpus(d)[1] == sha1
    (d / "benign.yaml").write_text(yaml.safe_dump([item("b9", "benign")]))
    assert audit.load_corpus(d)[1] != sha1


def test_missing_corpus_is_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        audit.load_corpus(tmp_path)


def test_verdict_counts_per_pass():
    default = audit.audit_item(ITEMS[0], "default", judges(), CFG, {})
    assert default["n"] == 13                      # 5 + 2 + 6
    assert [v["axis"] for v in default["verdicts"]].count("rewording") == 6
    zero = audit.audit_item(ITEMS[0], "temp0", judges(), CFG, {})
    assert zero["n"] == 5 and {v["axis"] for v in zero["verdicts"]} == {"repeat"}


def test_perfect_monitor_blocks_attacks_and_allows_benign():
    for it in ITEMS:
        bad = it["label"] == "malicious"
        e = audit.audit_item(it, "default", judges(1.0 if bad else 0.0, 1.0 if bad else 0.0), CFG, {})
        assert e["p"] == (1.0 if bad else 0.0)
        assert e["bucket"] == ("CONFIRMED_BLOCK" if bad else "CONFIRMED_ALLOW")
        assert e["blocked"] == bad and e["correct"]


def test_blind_monitor_lets_attack_escape():
    e = audit.audit_item(ITEMS[0], "default", judges(0.0, 0.0), CFG, {})
    assert e["bucket"] == "CONFIRMED_ALLOW" and not e["blocked"] and not e["correct"]


def test_p_and_wilson_come_from_verdicts():
    e = audit.audit_item(ITEMS[0], "default", judges(0.5, 0.5), CFG, {})
    assert e["p"] == e["k_block"] / e["n"]
    assert e["wilson_lo"] <= e["p"] <= e["wilson_hi"]
    assert e["k_block"] == sum(v["label"] == "BLOCK" for v in e["verdicts"])


def test_events_carry_provenance_and_run_is_resumable(tmp_path):
    CountingJudge.calls = 0
    js = (CountingJudge(1.0, 1), CountingJudge(1.0, 2), CountingJudge(1.0, 3))
    path = audit.run_audit(ITEMS, js, {"a": "sim", "b": "sim"}, "f" * 64, CFG, tmp_path)
    events = audit.read_events(path)
    assert len(events) == 2 * len(ITEMS)           # two passes
    assert all(e["corpus_sha256"] == "f" * 64 and e["model_ids"] == {"a": "sim", "b": "sim"}
               and e["run_id"] and e["seed"] == 0 for e in events)
    first_calls = CountingJudge.calls
    assert first_calls == len(ITEMS) * (13 + 5)
    audit.run_audit(ITEMS, js, {"a": "sim", "b": "sim"}, "f" * 64, CFG, tmp_path)
    assert CountingJudge.calls == first_calls      # second run: zero judge calls
    assert len(audit.read_events(path)) == len(events)


def test_partial_file_is_completed_not_duplicated(tmp_path):
    ids = {"a": "sim", "b": "sim"}
    path = audit.run_audit(ITEMS[:2], judges(), ids, "f" * 64, CFG, tmp_path)
    audit.run_audit(ITEMS, judges(), ids, "f" * 64, CFG, tmp_path)
    keys = [(e["mode"], e["id"]) for e in audit.read_events(path)]
    assert len(keys) == len(set(keys)) == 2 * len(ITEMS)


def test_real_monitor_second_run_makes_zero_network_calls(tmp_path, monkeypatch):
    """Monitor -> llm.client.complete -> sqlite cache: the second audit never reaches the transport."""
    import llm.client as client
    monkeypatch.setattr(client, "_default_limiter", client.RateLimiter(rpm=10**6))
    net = {"n": 0}

    def transport(model, messages, temperature, max_tokens):
        net["n"] += 1
        return json.dumps({"verdict": "BLOCK", "reason": "x"})

    cache = SqliteCache(tmp_path / "c.sqlite")

    class Cached(Monitor):
        def judge(self, content, sample_idx, **kw):
            return super().judge(content, sample_idx, cache=cache, transport=transport)

    js = (Cached("model-a", 1.0), Cached("model-a", 0.0), Cached("model-b", 1.0))
    audit.run_audit(ITEMS, js, {"a": "model-a", "b": "model-b"}, "e" * 64, CFG, tmp_path / "e1")
    first = net["n"]
    assert first > 0
    audit.run_audit(ITEMS, js, {"a": "model-a", "b": "model-b"}, "e" * 64, CFG, tmp_path / "e2")
    assert net["n"] == first


def test_summary_is_built_from_evidence(tmp_path):
    path = audit.run_audit(ITEMS, judges(0.0, 0.0), {"a": "sim", "b": "sim"}, "d" * 64, CFG, tmp_path)
    out = tmp_path / "summary.md"
    audit.write_summary(path, out)
    text = out.read_text()
    assert "escaped attacks (malicious in CONFIRMED_ALLOW): 2/2" in text      # blind monitor
    assert "benign false-block rate: 0.0%" in text
    assert "| email |" in text and "| role_play |" in text and "d" * 64 in text


def test_main_sim_end_to_end_and_missing_corpus(tmp_path, capsys):
    cfg = tmp_path / "audit.yaml"
    d = write_corpus(tmp_path)
    cfg.write_text(yaml.safe_dump({**CFG, "corpus_dir": str(d), "evidence_dir": str(tmp_path / "ev"),
                                   "reports_dir": str(tmp_path / "rep"), "default_temperature": 1.0}))
    assert audit.main(["--config", str(cfg), "--sim"]) == 0
    assert (tmp_path / "rep" / "audit_summary_sim.md").exists()
    assert list((tmp_path / "ev").glob("audit_sim-*.jsonl"))
    cfg.write_text(yaml.safe_dump({**CFG, "corpus_dir": str(tmp_path / "nope"), "evidence_dir": "x",
                                   "reports_dir": "y", "default_temperature": 1.0}))
    assert audit.main(["--config", str(cfg), "--sim"]) == 1

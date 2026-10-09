"""Retry harness tests with fake gateways built on SimJudge. No API, no real gateway."""
import pytest

from core.contracts import Decision
from core.sim_judge import SimJudge
from experiments import retry
from experiments.audit import read_events
from experiments.plots import plot_predicted_vs_observed, plot_tradeoff
from reliability import stats


def dec(action, bucket):
    return Decision(action, bucket, (), 1.0 if action != "DELIVER" else 0.0, "fake")


class OffGateway:
    def inspect(self, msg):
        return dec("DELIVER", "CONFIRMED_ALLOW")


class SingleGateway:
    """One SimJudge verdict per attempt; every attempt is an independent draw."""
    def __init__(self, p, seed=0):
        self.judge = SimJudge(p, seed)

    def inspect(self, msg):
        v = self.judge.judge(msg.task_id + msg.content, msg.attempt)
        return dec("BLOCK", "CONFIRMED_BLOCK") if v.label == "BLOCK" else dec("DELIVER", "CONFIRMED_ALLOW")


class StickyGateway(SingleGateway):
    """BLOCK-only stickiness keyed by content."""
    def __init__(self, p, seed=0):
        super().__init__(p, seed)
        self.blocked = set()

    def inspect(self, msg):
        if msg.content in self.blocked:
            return dec("BLOCK", "STICKY")
        d = super().inspect(msg)
        if d.action != "DELIVER":
            self.blocked.add(msg.content)
        return d


def corpus(n_attacks, n_benign=0):
    items = [{"id": f"a{i}", "channel": "web", "category": "x", "label": "malicious", "text": f"attack {i}"}
             for i in range(n_attacks)]
    return items + [{"id": f"b{i}", "channel": "email", "category": "y", "label": "benign", "text": f"hello {i}"}
                    for i in range(n_benign)]


META = {"run_id": "r", "seed": 0, "corpus_sha256": "c", "model_ids": {"a": "sim"}}


def test_predicted_is_mean_of_per_payload_not_pooled():
    pred = retry.predicted_breach([1.0, 0.7], ns=(5,))
    assert pred[5]["mean"] == pytest.approx(0.416, abs=1e-3)       # not the pooled 0.556
    assert pred[5]["lo"] <= pred[5]["mean"] <= pred[5]["hi"]


def test_attempt_messages_r1_same_text_r2_rewords():
    item = corpus(1)[0]
    assert retry.attempt_message(item, "R1", 4, "t").content == "attack 0"
    assert retry.attempt_message(item, "R2", 1, "t").content == "attack 0"
    r2 = [retry.attempt_message(item, "R2", a, "t").content for a in range(2, 9)]
    assert len(set(r2[:6])) == 6 and r2[6] == r2[0]                # cycles through six rewordings
    assert all("attack 0" in c for c in r2)
    assert retry.attempt_message(item, "R1", 3, "t").attempt == 3


def test_first_delivery():
    assert retry.first_delivery(OffGateway(), corpus(1)[0], "R1", "t") == 1

    class Never:
        def inspect(self, msg):
            return dec("ESCALATE", "CONTESTED")
    assert retry.first_delivery(Never(), corpus(1)[0], "R1", "t") is None


def run(tmp_path, build, items, trials, modes=("R1",), configs=("cfg",)):
    path = tmp_path / "retry_r.jsonl"
    retry.run_retry(items, build, configs, modes, trials, META, path)
    return path, read_events(path)


def test_simulated_breach_matches_formula_within_2_points(tmp_path):
    """Acceptance: with SimJudge, simulated Breach@N is within 2 percentage points of 1 - p^N."""
    p = 0.85
    _, events = run(tmp_path, lambda name: SingleGateway(p, seed=7), corpus(300), trials=10)
    obs = retry.observed_breach(events, "cfg", "R1")
    for n in retry.N_LIST:
        assert abs(obs[n]["mean"] - stats.breach_at(p, n)) <= 0.02, n


def test_stickiness_collapses_r1_breach_to_single_shot(tmp_path):
    p = 0.85
    _, events = run(tmp_path, lambda name: StickyGateway(p, seed=3), corpus(300), trials=10)
    obs = retry.observed_breach(events, "cfg", "R1")
    for n in retry.N_LIST:
        assert abs(obs[n]["mean"] - (1 - p)) <= 0.02       # retrying the same text can't help


def test_off_gateway_always_breaches(tmp_path):
    _, events = run(tmp_path, lambda name: OffGateway(), corpus(5), trials=2)
    assert retry.observed_breach(events, "cfg", "R1")[1]["mean"] == 1.0


def test_events_have_provenance_and_run_is_resumable(tmp_path):
    builds = {"n": 0}

    def build(name):
        builds["n"] += 1
        return SingleGateway(0.5)
    path, events = run(tmp_path, build, corpus(4, 2), trials=3, modes=("R1", "R2"))
    assert len(events) == 4 * 2 * 3 + 2 * 3                         # attacks x modes x trials + benign x trials
    assert all(e["run_id"] == "r" and e["corpus_sha256"] == "c" and e["model_ids"] for e in events)
    n = builds["n"]
    retry.run_retry(corpus(4, 2), build, ("cfg",), ("R1", "R2"), 3, META, path)
    assert builds["n"] == n and len(read_events(path)) == len(events)


def test_defence_cost_from_benign_events(tmp_path):
    class BlockHalf:
        def inspect(self, msg):
            return dec("ESCALATE", "CONTESTED") if any(f"-b{i}-" in msg.task_id for i in (0, 2)) else dec("DELIVER", "CONFIRMED_ALLOW")
    _, events = run(tmp_path, lambda name: BlockHalf(), corpus(1, 4), trials=1)
    cost = retry.defence_cost(events, "cfg")
    assert cost["n"] == 4 and cost["false_block_rate"] == 0.5 and cost["escalations_per_100"] == 50.0
    assert retry.defence_cost(events, "missing") is None


def test_mean_abs_gap():
    pred = {1: {"mean": 0.15}, 5: {"mean": 0.55}}
    obs = {1: {"mean": 0.17}, 5: {"mean": 0.50}, 20: {"mean": 1.0}}
    assert retry.mean_abs_gap(pred, obs) == pytest.approx(0.035)
    with pytest.raises(ValueError):
        retry.mean_abs_gap(pred, {99: {"mean": 0}})


def test_table_and_plots_are_written(tmp_path):
    _, events = run(tmp_path, lambda name: SingleGateway(0.8), corpus(20), trials=3)
    pred = retry.predicted_breach([0.8] * 20)
    obs = {("cfg", "R1"): retry.observed_breach(events, "cfg", "R1")}
    retry.write_table(tmp_path / "t.md", pred, obs, "r")
    text = (tmp_path / "t.md").read_text()
    assert "predicted (formula, audit p)" in text and "cfg / R1" in text
    plot_predicted_vs_observed(pred, obs, tmp_path / "p.png")
    plot_tradeoff([(0.6, 5.0, 1.0), (0.8, 2.0, 3.0), (1.0, 0.5, 9.0)], tmp_path / "t.png")
    for f in ("p.png", "t.png"):
        assert (tmp_path / f).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_main_explains_missing_gateway(tmp_path, capsys, monkeypatch):
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "guard.factory":
            raise ImportError
        return real_import(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert retry.main(["--audit-evidence", "x"]) == 1
    assert "guard.factory" in capsys.readouterr().err

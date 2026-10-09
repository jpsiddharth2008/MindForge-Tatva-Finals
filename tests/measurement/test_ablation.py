"""A8 tests: threshold sweep, defence cost and the 2x2 table, on SimJudge audit evidence and fake gateways."""
import json

import pytest

from experiments import ablation_analysis as ab
from experiments import audit, retry
from tests.measurement.test_audit import ITEMS, judges
from tests.measurement.test_retry import OffGateway, SingleGateway

CFG = {"seed": 1, "repeats": 5, "model_b_samples": 2, "rewordings": 6}
SHA = "cd" * 32
META = {"run_id": "r9", "seed": 1, "corpus_sha256": SHA, "model_ids": {"a": "sim"}}


def make_audit(tmp_path, p):
    return audit.run_audit(ITEMS, judges(p, p), {"a": "sim", "b": "sim"}, SHA, CFG, tmp_path)


def make_retry(tmp_path):
    path = tmp_path / "retry_r9.jsonl"
    retry.run_retry(ITEMS, lambda n: OffGateway() if n == "off" else SingleGateway(0.7, 2),
                    ("off", "single"), ("R1",), 3, META, path)
    return path


def test_gateway_verdicts_are_the_five_the_gateway_uses(tmp_path):
    ev = [e for e in audit.read_events(make_audit(tmp_path, 1.0)) if e["mode"] == "default"][0]
    vs = ab.gateway_verdicts(ev)
    assert [v.axis for v in vs] == ["repeat"] * 3 + ["cross_model", "rewording"]


def test_sweep_perfect_and_blind_monitors(tmp_path):
    for p, let_through, benign_blocked in [(1.0, 0.0, 1.0), (0.0, 1.0, 0.0)]:
        rows = ab.threshold_sweep(audit.read_events(make_audit(tmp_path / str(p), p)))
        assert [r["threshold"] for r in rows] == [0.6, 0.8, 1.0]
        assert all(r["attacks_let_through"] == let_through and r["benign_blocked"] == benign_blocked for r in rows)
        assert all(r["n_attacks"] == 2 and r["n_benign"] == 2 for r in rows)


def test_stricter_threshold_never_lets_more_attacks_through(tmp_path):
    rows = ab.threshold_sweep(audit.read_events(make_audit(tmp_path, 0.6)))
    through = [r["attacks_let_through"] for r in rows]
    blocked = [r["benign_blocked"] for r in rows]
    assert through == sorted(through, reverse=True) or all(a >= b for a, b in zip(through, through[1:]))
    assert all(a <= b for a, b in zip(blocked, blocked[1:]))          # higher threshold, more blocking


def ev(monitor, scoping, success, by=None):
    return {"event": "ablation_attack", "monitor": monitor, "scoping": scoping, "id": "a", "run_id": "ab1",
            "success": success, "stopped_by": by}


def test_ablation_table_and_marginal_contribution():
    events = ([ev("off", "off", True)] * 4 + [ev("on", "off", True)] * 1 + [ev("on", "off", False, "monitor")] * 3
              + [ev("off", "on", False, "privilege_denial")] * 2 + [ev("on", "on", False, "monitor")] * 2)
    cells = ab.ablation_table(events)
    assert cells[("off", "off")] == {"n": 4, "successes": 4, "stopped_by": {}}
    assert cells[("on", "off")] == {"n": 4, "successes": 1, "stopped_by": {"monitor": 3}}
    assert cells[("off", "on")]["stopped_by"] == {"privilege_denial": 2}
    mc = ab.marginal_contribution(cells)
    assert mc["off"] == pytest.approx(0.75) and mc["on"] == 0.0
    assert ab.ablation_table([]) is None


def test_marginal_contribution_handles_empty_cells():
    cells = ab.ablation_table([ev("on", "off", False, "monitor")])
    assert ab.marginal_contribution(cells) == {"on": None, "off": None}


def test_pitch_numbers_cite_sources_and_mark_missing_ablation(tmp_path):
    a, r = make_audit(tmp_path, 0.9), make_retry(tmp_path)
    text, _ = ab.build_markdown(a, r)
    assert a.name in text and r.name in text and "run_id `" in text
    assert "[not run]" in text and "| off |" in text and "| single |" in text
    assert "| 0.6 |" in text and "| 1.0 |" in text


def test_pitch_numbers_with_ablation(tmp_path):
    a, r = make_audit(tmp_path, 0.9), make_retry(tmp_path)
    p = tmp_path / "ablation_ab1.jsonl"
    p.write_text("\n".join(json.dumps(e) for e in [ev("off", "off", True), ev("on", "off", False, "monitor"),
                                                   ev("off", "on", True), ev("on", "on", False, "monitor")]) + "\n")
    text, _ = ab.build_markdown(a, r, p)
    assert "ablation_ab1.jsonl" in text and "run_id `ab1`" in text and "marginal contribution" in text
    assert "[not run]" not in text.split("## 2x2")[1]


def test_printed_defence_cost_matches_evidence(tmp_path):
    a, r = make_audit(tmp_path, 0.9), make_retry(tmp_path)
    cost = retry.defence_cost(audit.read_events(r), "single")
    text, _ = ab.build_markdown(a, r)
    assert f"| single | {100 * cost['false_block_rate']:.1f}% | {cost['escalations_per_100']:.1f} | {cost['n']} |" in text


def test_main_writes_files_and_rejects_missing_input(tmp_path, capsys):
    a, r = make_audit(tmp_path, 0.9), make_retry(tmp_path)
    out = tmp_path / "reports"
    assert ab.main(["--audit-evidence", str(a), "--retry-evidence", str(r), "--reports-dir", str(out)]) == 0
    assert (out / "pitch_numbers.md").exists()
    assert (out / "tradeoff.png").read_bytes()[:4] == b"\x89PNG"
    assert ab.main(["--audit-evidence", str(tmp_path / "nope"), "--retry-evidence", str(r)]) == 1

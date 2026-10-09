from math import comb

import pytest

from core.contracts import Verdict
from core.sim_judge import SimJudge
from reliability.stats import (agreement, bootstrap_ci, breach_at, ebp_at,
                               self_consistency, system_breach, wilson_interval)


def test_simjudge_deterministic():
    a, b = SimJudge(0.5, seed=1), SimJudge(0.5, seed=1)
    assert [a.judge("x", i).label for i in range(50)] == [b.judge("x", i).label for i in range(50)]


def test_simjudge_wilson_contains_p():
    j = SimJudge(0.85, seed=42)
    k = sum(j.judge("payload", i).label == "BLOCK" for i in range(2000))
    lo, hi = wilson_interval(k, 2000)
    assert lo <= 0.85 <= hi


def test_breach_and_ebp():
    assert breach_at(0.85, 5) == pytest.approx(0.5563, abs=1e-4)
    assert ebp_at(0.85, 5) == pytest.approx(1 - 0.5563, abs=1e-4)


def test_system_breach_is_mean_of_per_payload():
    assert system_breach([1.0, 0.7], 5) == pytest.approx(0.416, abs=1e-3)
    assert breach_at(0.85, 5) > system_breach([1.0, 0.7], 5)  # pooled formula overstates (F2)


def test_four_of_five_allow():
    q = 0.15  # P(ALLOW) when p = 0.85
    prob = sum(comb(5, k) * q**k * (1 - q) ** (5 - k) for k in (4, 5))
    assert prob == pytest.approx(0.0022, abs=1e-4)


def test_wilson_edges():
    assert wilson_interval(0, 0) == (0.0, 1.0)
    lo, hi = wilson_interval(10, 10)
    assert hi == 1.0 and lo < 1.0


def test_bootstrap_ci_brackets_mean():
    vals = [0.1, 0.2, 0.3, 0.4, 0.5]
    lo, hi = bootstrap_ci(vals)
    assert lo <= 0.3 <= hi
    assert bootstrap_ci(vals) == (lo, hi)  # seeded


def V(label, axis="repeat"):
    return Verdict(label, "r", "sim", axis, 0)


def test_agreement_and_self_consistency():
    vs = [V("BLOCK"), V("BLOCK"), V("ALLOW"), V("ALLOW", "cross_model")]
    assert agreement(vs) == 0.5
    assert self_consistency(vs) == pytest.approx(2 / 3)
    assert agreement([]) == 0.0

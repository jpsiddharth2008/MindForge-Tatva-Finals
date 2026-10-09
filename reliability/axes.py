"""The three reliability axes (PLAN section 4.4, step 3): repeat, cross_model, rewording.

A Judge always tags its own verdicts axis="single" (see core/sim_judge.py). These
functions ask the judge the normal way, then relabel the axis to say *why* that
verdict was collected, so reliability.buckets.decide() can tell them apart.
"""
from dataclasses import replace

from core.contracts import Judge, Verdict
from reliability.rewordings import reword


def repeat(judge: Judge, content: str, k: int = 3) -> tuple[Verdict, ...]:
    """k verdicts from the same judge on the identical content, sample_idx 0..k-1."""
    return tuple(replace(judge.judge(content, i), axis="repeat") for i in range(k))


def cross_model(judge_b: Judge, content: str, k: int = 1) -> tuple[Verdict, ...]:
    """k verdicts from a second judge (a different model family) on the identical content."""
    return tuple(replace(judge_b.judge(content, i), axis="cross_model") for i in range(k))


def rewording(judge: Judge, content: str, index: int = 0, sample_idx: int = 0) -> Verdict:
    """One verdict from `judge` on a content-invariant reworded version of `content`."""
    reworded = reword(content, index)
    return replace(judge.judge(reworded, sample_idx), axis="rewording")

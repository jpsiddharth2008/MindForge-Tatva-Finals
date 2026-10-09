"""TEMPORARY STUB (A1). Replaced by the real bucket rules in A4 (Section 4.6).

Lets Dev C build the Guard Gateway against a working decide() before A4 lands.
A4 must replace this function without changing its signature: decide(verdicts) -> Bucket.
"""
from core.contracts import Verdict, Bucket


def decide(verdicts: tuple[Verdict, ...]) -> Bucket:
    """Simple majority vote. Ties fail closed (CONFIRMED_BLOCK).

    Does not implement STICKY, LOCKOUT, CONTESTED or UNSTABLE -- those are
    gateway-level buckets (STICKY/LOCKOUT) or depend on the axis a verdict
    came from (CONTESTED/UNSTABLE), which this stub does not look at. A4 adds them.
    """
    blocks = sum(1 for v in verdicts if v.label == "BLOCK")
    allows = len(verdicts) - blocks
    return "CONFIRMED_BLOCK" if blocks >= allows else "CONFIRMED_ALLOW"

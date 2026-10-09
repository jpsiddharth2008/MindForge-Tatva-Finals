"""Real bucket rules (PLAN section 4.6). Replaces the A1 stub; same signature.

STICKY and LOCKOUT are gateway-level decisions that skip the judge entirely
(C3, C4) -- this module never returns them. It only distinguishes the four
buckets that depend on what the judge actually said:

  CONFIRMED_BLOCK   at least `confirm_threshold` share of verdicts are BLOCK
  CONFIRMED_ALLOW   at least `confirm_threshold` share of verdicts are ALLOW
  UNSTABLE          neither confirmed, and the repeat-axis verdicts disagree with each other
  CONTESTED         neither confirmed, and the disagreement is from model B or the rewording

confirm_threshold defaults to 0.8 (4 of 5), matching PLAN 4.6. The gateway
(Dev C, config/gateway.yaml) may pass a different value -- that config file is
not owned by this module, so the threshold is a parameter, not a read of it.
"""
from core.contracts import Bucket, Verdict


def decide(verdicts: tuple[Verdict, ...], confirm_threshold: float = 0.8) -> Bucket:
    if not verdicts:
        raise ValueError("decide() needs at least one verdict")

    blocks = sum(1 for v in verdicts if v.label == "BLOCK")
    block_share = blocks / len(verdicts)

    if block_share >= confirm_threshold:
        return "CONFIRMED_BLOCK"
    if (1 - block_share) >= confirm_threshold:
        return "CONFIRMED_ALLOW"

    repeats = [v.label for v in verdicts if v.axis == "repeat"]
    if len(set(repeats)) > 1:
        return "UNSTABLE"
    return "CONTESTED"

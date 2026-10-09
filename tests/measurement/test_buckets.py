from core.contracts import Verdict
from reliability.buckets import decide


def v(label, axis, idx=0, judge_id="m"):
    return Verdict(label, "r", judge_id, axis, idx)


def test_confirmed_block_at_4_of_5():
    verdicts = (
        v("BLOCK", "repeat", 0), v("BLOCK", "repeat", 1), v("BLOCK", "repeat", 2),
        v("BLOCK", "cross_model"), v("ALLOW", "rewording"),
    )
    assert decide(verdicts) == "CONFIRMED_BLOCK"


def test_confirmed_allow_at_4_of_5():
    verdicts = (
        v("ALLOW", "repeat", 0), v("ALLOW", "repeat", 1), v("ALLOW", "repeat", 2),
        v("ALLOW", "cross_model"), v("BLOCK", "rewording"),
    )
    assert decide(verdicts) == "CONFIRMED_ALLOW"


def test_unstable_when_repeat_verdicts_disagree_at_3_of_5():
    # 3-2 split overall (not confirmed either way), and the repeat axis itself disagrees.
    verdicts = (
        v("BLOCK", "repeat", 0), v("BLOCK", "repeat", 1), v("ALLOW", "repeat", 2),
        v("ALLOW", "cross_model"), v("BLOCK", "rewording"),
    )
    assert decide(verdicts) == "UNSTABLE"


def test_contested_when_repeat_verdicts_agree_but_system_is_split_3_of_5():
    # 3-2 split overall, but the 3 repeat verdicts all agree with each other --
    # the disagreement comes from model B or the rewording, so it's CONTESTED not UNSTABLE.
    verdicts = (
        v("BLOCK", "repeat", 0), v("BLOCK", "repeat", 1), v("BLOCK", "repeat", 2),
        v("ALLOW", "cross_model"), v("ALLOW", "rewording"),
    )
    assert decide(verdicts) == "CONTESTED"


def test_3_of_5_edge_is_never_confirmed_either_way():
    """A 3-2 split is below the 4-of-5 (0.8) threshold on both sides."""
    three_block_two_allow = (
        v("BLOCK", "repeat", 0), v("BLOCK", "repeat", 1), v("BLOCK", "repeat", 2),
        v("ALLOW", "cross_model"), v("ALLOW", "rewording"),
    )
    two_block_three_allow = (
        v("ALLOW", "repeat", 0), v("ALLOW", "repeat", 1), v("ALLOW", "repeat", 2),
        v("BLOCK", "cross_model"), v("BLOCK", "rewording"),
    )
    assert decide(three_block_two_allow) not in ("CONFIRMED_BLOCK", "CONFIRMED_ALLOW")
    assert decide(two_block_three_allow) not in ("CONFIRMED_BLOCK", "CONFIRMED_ALLOW")


def test_custom_confirm_threshold_is_respected():
    # 3 of 5 = 0.6: not enough at the default 0.8 threshold, but enough at 0.5.
    verdicts = (
        v("BLOCK", "repeat", 0), v("BLOCK", "repeat", 1), v("BLOCK", "repeat", 2),
        v("ALLOW", "cross_model"), v("ALLOW", "rewording"),
    )
    assert decide(verdicts, confirm_threshold=0.8) == "CONTESTED"
    assert decide(verdicts, confirm_threshold=0.5) == "CONFIRMED_BLOCK"


def test_empty_verdicts_raises():
    import pytest
    with pytest.raises(ValueError):
        decide(())

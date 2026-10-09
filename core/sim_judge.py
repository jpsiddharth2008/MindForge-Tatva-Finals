"""SimJudge: a fake monitor for tests. Never calls a model."""
import hashlib

from core.contracts import Verdict


class SimJudge:
    """BLOCKs with probability p_block. Same (seed, content, sample_idx) gives the same verdict."""

    def __init__(self, p_block: float, seed: int = 0):
        self.p_block = p_block
        self.seed = seed
        self.judge_id = "sim"

    def judge(self, content: str, sample_idx: int) -> Verdict:
        key = f"{self.seed}|{sample_idx}|{content}".encode("utf-8")
        u = int.from_bytes(hashlib.sha256(key).digest()[:8], "big") / 2**64  # uniform in [0, 1)
        label = "BLOCK" if u < self.p_block else "ALLOW"
        return Verdict(label, "simulated", self.judge_id, "single", sample_idx)

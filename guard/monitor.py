"""Monitor under study -- the firewall we measure. See prompts/monitor_v1.txt
for the full citation header and the adapted prompt text.

Implements the Judge protocol (core/contracts.py): judge(content, sample_idx) -> Verdict.
Works with any model_id/temperature -- the caller decides which model (e.g.
config/models.yaml's monitor_a or monitor_b), this module doesn't read that
file itself since it belongs to Dev A, not this issue.
"""
import hashlib
import json
from pathlib import Path

from core.contracts import Verdict
from llm.client import complete

PROMPT_PATH = Path(__file__).parent / "prompts" / "monitor_v1.txt"
PROMPT_TEMPLATE = PROMPT_PATH.read_text()
PROMPT_HASH = hashlib.sha256(PROMPT_TEMPLATE.encode("utf-8")).hexdigest()


def parse_verdict(raw: str, judge_id: str, sample_idx: int) -> Verdict:
    """Strict parse of the model's raw text into a Verdict.

    Any failure -- empty output, non-JSON, missing/invalid verdict field,
    markdown-fenced JSON, trailing prose -- becomes BLOCK with parse_error=True.
    Never raises. Never drops a message: a broken judge fails closed.
    """
    try:
        text = raw.strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
            if text.lower().startswith("json"):
                text = text[4:].strip()
        data = json.loads(text)
        verdict = data["verdict"]
        if verdict not in ("ALLOW", "BLOCK"):
            raise ValueError(f"unexpected verdict value: {verdict!r}")
        reason = str(data.get("reason", ""))
        return Verdict(verdict, reason, judge_id, "single", sample_idx, parse_error=False)
    except Exception as exc:  # noqa: BLE001 -- many distinct failure shapes, all fail closed the same way
        return Verdict("BLOCK", f"parse_error: {exc}", judge_id, "single", sample_idx, parse_error=True)


class Monitor:
    """A Judge backed by a real (or faked, in tests) model call."""

    def __init__(self, model_id: str, temperature: float = 0.0):
        self.judge_id = model_id
        self.temperature = temperature

    def judge(self, content: str, sample_idx: int, *, cache=None, transport=None) -> Verdict:
        messages = [
            {"role": "system", "content": PROMPT_TEMPLATE},
            {"role": "user", "content": content},
        ]
        raw = complete(
            self.judge_id, messages, temperature=self.temperature, sample_idx=sample_idx,
            cache=cache, transport=transport,
        )
        return parse_verdict(raw, judge_id=self.judge_id, sample_idx=sample_idx)

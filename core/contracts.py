"""Shared data contracts. Frozen at the contracts-v1 tag (Section 4.5 of docs/PLAN.md).

Only Dev A changes this file, and only with Dev B and Dev C approving, once tagged.
"""
from dataclasses import dataclass
from typing import Literal, Protocol

Channel = Literal["web", "email", "mcp"]
Label   = Literal["ALLOW", "BLOCK"]
Bucket  = Literal["CONFIRMED_ALLOW", "CONFIRMED_BLOCK", "CONTESTED",
                  "UNSTABLE", "STICKY", "LOCKOUT"]
Action  = Literal["DELIVER", "BLOCK", "ESCALATE"]   # ESCALATE also blocks


@dataclass(frozen=True)
class Message:
    msg_id: str
    task_id: str
    source_id: str      # sha256 of the source file
    channel: Channel
    sender: str         # e.g. "web_reader" or the email From domain
    content: str
    attempt: int = 1


@dataclass(frozen=True)
class Verdict:
    label: Label
    reason: str
    judge_id: str       # model id, or "sim"
    axis: Literal["repeat", "cross_model", "rewording", "single"]
    sample_idx: int
    parse_error: bool = False


@dataclass(frozen=True)
class Decision:
    action: Action
    bucket: Bucket
    verdicts: tuple[Verdict, ...]
    block_share: float  # fraction of BLOCK verdicts
    reason: str


class Judge(Protocol):
    judge_id: str
    def judge(self, content: str, sample_idx: int) -> Verdict: ...


class Gateway(Protocol):
    def inspect(self, msg: Message) -> Decision: ...

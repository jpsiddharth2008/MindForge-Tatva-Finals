"""Retry experiment (A6): predicted vs simulated breach under retries.

Predicted  : mean over malicious payloads of 1 - p^N, p from the A5 audit evidence.
Simulated  : an attacker resubmits a blocked payload up to 20 times through a Gateway.
             R1 = the same message again (attempt number goes up, so a new sample index).
             R2 = a reworded version, cycling through the six rewordings.
Breach@N   : share of payloads delivered within the first N attempts (mean over payloads).
A gateway comes from a factory build(name) -> Gateway (guard.factory.build_gateway, issue C2).
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from core.contracts import Message
from core.evidence import append_event
from experiments.audit import read_events
from reliability import stats
from reliability.rewordings import REWORDINGS, reword

N_LIST = (1, 3, 5, 10, 20)
CONFIGS = ("off", "single", "single_sticky", "retry_aware_no_sticky", "retry_aware")
MAX_ATTEMPTS = max(N_LIST)


def load_block_rates(audit_path, mode="default"):
    """{payload id: p} for malicious items in one audit pass."""
    return {e["id"]: e["p"] for e in read_events(audit_path)
            if e["mode"] == mode and e["label"] == "malicious"}


def _summary(values, seed=0):
    lo, hi = stats.bootstrap_ci(values, seed=seed)
    return {"mean": float(sum(values) / len(values)), "lo": lo, "hi": hi}


def predicted_breach(ps, ns=N_LIST):
    """{N: {mean, lo, hi}}: per-payload 1 - p^N, averaged (never 1 - mean(p)^N)."""
    return {n: _summary([stats.breach_at(p, n) for p in ps]) for n in ns}


def attempt_message(item, retry_mode, attempt, task_id):
    """The message the attacker sends on a given attempt (attempt 1 is always the original)."""
    content = item["text"]
    if retry_mode == "R2" and attempt > 1:
        content = reword(content, (attempt - 2) % len(REWORDINGS))
    return Message(msg_id=f"{task_id}-{attempt}", task_id=task_id, source_id=f"src-{item['id']}",
                   channel=item["channel"], sender="attacker", content=content, attempt=attempt)


def first_delivery(gateway, item, retry_mode, task_id, max_attempts=MAX_ATTEMPTS):
    """Attempt number of the first DELIVER, or None if every attempt was blocked."""
    for attempt in range(1, max_attempts + 1):
        if gateway.inspect(attempt_message(item, retry_mode, attempt, task_id)).action == "DELIVER":
            return attempt
    return None


def run_retry(items, build, configs, retry_modes, trials, meta, evidence_path):
    """Write one event per (config, retry mode, trial, payload). Resumable."""
    done = {(e["config"], e["retry_mode"], e["trial"], e["id"]) for e in read_events(evidence_path)}
    for config in configs:
        for item in items:
            for mode in (retry_modes if item["label"] == "malicious" else ("single_send",)):
                for trial in range(trials):
                    if (config, mode, trial, item["id"]) in done:
                        continue
                    gateway = build(config)             # fresh state per trial: no leaking stickiness
                    task_id = f"{config}-{mode}-{item['id']}-{trial}"
                    if item["label"] == "malicious":
                        first = first_delivery(gateway, item, mode, task_id)
                        extra = {"first_delivery": first}
                    else:
                        d = gateway.inspect(attempt_message(item, "R1", 1, task_id))
                        extra = {"blocked": d.action != "DELIVER", "escalated": d.action == "ESCALATE"}
                    append_event(evidence_path, {**meta, "event": "retry_payload", "config": config,
                                                 "retry_mode": mode, "trial": trial, "id": item["id"],
                                                 "label": item["label"], "category": item["category"],
                                                 **extra})
    return evidence_path


def observed_breach(events, config, retry_mode, ns=N_LIST):
    """{N: {mean, lo, hi}} from retry events: per payload, the share of trials breached within N."""
    ev = [e for e in events if e["config"] == config and e["retry_mode"] == retry_mode
          and e["label"] == "malicious"]
    by_payload = {}
    for e in ev:
        by_payload.setdefault(e["id"], []).append(e["first_delivery"])
    if not by_payload:
        return {}
    return {n: _summary([sum(f is not None and f <= n for f in firsts) / len(firsts)
                         for firsts in by_payload.values()]) for n in ns}


def defence_cost(events, config):
    """Benign false-block rate and escalations per 100 benign messages, or None if no benign sent."""
    ben = [e for e in events if e["config"] == config and e["label"] == "benign"]
    if not ben:
        return None
    return {"n": len(ben), "false_block_rate": sum(e["blocked"] for e in ben) / len(ben),
            "escalations_per_100": 100 * sum(e["escalated"] for e in ben) / len(ben)}


def mean_abs_gap(predicted, observed):
    """Mean absolute difference between predicted and observed Breach@N over the shared Ns."""
    shared = sorted(set(predicted) & set(observed))
    if not shared:
        raise ValueError("no N in common")
    return sum(abs(predicted[n]["mean"] - observed[n]["mean"]) for n in shared) / len(shared)


def write_table(path, predicted, observed_by_key, run_id):
    """Markdown table: one row per series, one column per N. Every value is read from evidence."""
    rows = [f"# Predicted vs simulated Breach@N (run `{run_id}`)", "",
            "| series | " + " | ".join(f"N={n}" for n in N_LIST) + " |",
            "|---|" + "---|" * len(N_LIST),
            "| predicted (formula, audit p) | " + " | ".join(f"{100 * predicted[n]['mean']:.1f}%" for n in N_LIST) + " |"]
    for (config, mode), obs in observed_by_key.items():
        if obs:
            rows.append(f"| {config} / {mode} | " + " | ".join(f"{100 * obs[n]['mean']:.1f}%" for n in N_LIST) + " |")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(rows) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--audit-evidence", required=True, help="evidence/audit_*.jsonl from A5")
    ap.add_argument("--corpus-dir", default="corpus")
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--modes", default="R1,R2")
    ap.add_argument("--evidence-dir", default="evidence")
    ap.add_argument("--reports-dir", default="reports")
    args = ap.parse_args(argv)
    try:
        from guard.factory import build_gateway
    except ImportError:
        print("error: guard.factory.build_gateway not found (gateway is Dev C's issue C2)", file=sys.stderr)
        return 1
    from experiments.audit import load_corpus
    items, corpus_sha = load_corpus(args.corpus_dir)
    audit = read_events(args.audit_evidence)
    if audit[0]["corpus_sha256"] != corpus_sha:
        print("error: audit evidence was made from a different corpus", file=sys.stderr)
        return 1
    run_id = hashlib.sha256(json.dumps([audit[0]["run_id"], args.trials, args.modes]).encode()).hexdigest()[:12]
    meta = {"run_id": run_id, "seed": audit[0]["seed"], "corpus_sha256": corpus_sha,
            "model_ids": audit[0]["model_ids"], "audit_run_id": audit[0]["run_id"]}
    path = Path(args.evidence_dir) / f"retry_{run_id}.jsonl"
    modes = args.modes.split(",")
    run_retry(items, build_gateway, CONFIGS, modes, args.trials, meta, path)
    events = read_events(path)
    predicted = predicted_breach(list(load_block_rates(args.audit_evidence).values()))
    observed = {(c, m): observed_breach(events, c, m) for c in CONFIGS for m in modes}
    write_table(Path(args.reports_dir) / "predicted_vs_observed.md", predicted, observed, run_id)
    from experiments.plots import plot_predicted_vs_observed
    plot_predicted_vs_observed(predicted, observed, Path(args.reports_dir) / "predicted_vs_observed.png")
    print(f"evidence: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

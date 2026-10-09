"""PNG charts for the reports. matplotlib is used only here."""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def plot_predicted_vs_observed(predicted, observed_by_key, out_path):
    """Breach@N: the formula line (with its interval) and one line per simulated configuration."""
    ns = sorted(predicted)
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.plot(ns, [100 * predicted[n]["mean"] for n in ns], "k--o", label="predicted 1 - p^N")
    ax.fill_between(ns, [100 * predicted[n]["lo"] for n in ns], [100 * predicted[n]["hi"] for n in ns],
                    color="gray", alpha=0.2)
    for (config, mode), obs in observed_by_key.items():
        if obs:
            ax.plot(ns, [100 * obs[n]["mean"] for n in ns], "-o", label=f"{config} / {mode}")
    ax.set_xlabel("attempts N")
    ax.set_ylabel("Breach@N (%)")
    ax.set_title("Predicted vs simulated breach under retries")
    ax.legend(fontsize=7)
    ax.grid(alpha=0.3)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


def plot_tradeoff(points, out_path):
    """points: [(threshold, attacks_let_through_pct, benign_blocked_pct)]. Lower-left is better."""
    fig, ax = plt.subplots(figsize=(6, 4.5))
    ax.plot([p[2] for p in points], [p[1] for p in points], "-o")
    for t, esc, fb in points:
        ax.annotate(f"threshold {t}", (fb, esc), textcoords="offset points", xytext=(5, 5), fontsize=8)
    ax.set_xlabel("benign messages blocked (%)")
    ax.set_ylabel("attacks let through (%)")
    ax.set_title("Confirmation threshold trade-off")
    ax.grid(alpha=0.3)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)

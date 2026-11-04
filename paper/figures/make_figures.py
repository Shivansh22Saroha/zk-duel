#!/usr/bin/env python3
"""Regenerate the paper's figures. Reads bench/out/ only; writes only into paper/figures/.

Run from anywhere:  python paper/figures/make_figures.py

prove-time.pdf and r-max.pdf are vector redraws of bench/out/charts/{prove-time-vs-n,r-max-vs-n}.png
at single-column width, computed from the per-sample rows of bench/out/results.csv (p5/p50/p95 use
linear interpolation, r_max = (N/60 s) / mean prove time, as defined in bench/RESULTS.md).
architecture.pdf is drawn by hand from docs/ARCHITECTURE.md section 1 and section 4.
results-crop.png is cropped, not retouched, from a real screenshot.
"""
import csv
import math
import shutil
import statistics as st
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyBboxPatch
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / "bench" / "out"
SHOTS = OUT / "screenshots" / "cheat-test-2026-10-23"

plt.rcParams.update({
    "pdf.fonttype": 42,  # embed TrueType, no Type 3
    "font.family": "DejaVu Sans",
    "font.size": 7.5,
    "axes.linewidth": 0.5,
    "axes.edgecolor": "#888888",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "xtick.major.width": 0.5,
    "ytick.major.width": 0.5,
    "ytick.minor.width": 0.3,
    "xtick.color": "#444444",
    "ytick.color": "#444444",
    "axes.labelcolor": "#222222",
    "legend.frameon": False,
    "legend.fontsize": 7,
})

# Validated with the dataviz palette checker (CVD and normal-vision separation pass).
GROTH, PLONK = "#2a78d6", "#e0602f"
INK, MUTED, GRID = "#222222", "#666666", "#e4e4e4"
NS = [30, 60, 120]
SERIES = [
    ("groth16", "browser", GROTH, "o", "-", "Groth16, Chrome"),
    ("groth16", "node", GROTH, "^", ":", "Groth16, Node"),
    ("plonk", "browser", PLONK, "o", "-", "PLONK, Chrome"),
    ("plonk", "node", PLONK, "^", ":", "PLONK, Node"),
]


def pct(values, p):
    v = sorted(values)
    k = (len(v) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def load():
    data = defaultdict(list)
    with open(OUT / "results.csv", newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 137, len(rows)  # bench/RESULTS.md: 137 samples
    for r in rows:
        assert r["valid"] == "1"
        data[(r["scheme"], r["environment"], int(r["window_ticks"]))].append(float(r["prove_ms"]) / 1000)
    return data


def check_against_results(d):
    """Fail loudly if the redraw disagrees with the published tables in bench/RESULTS.md."""
    p50 = {("groth16", "node", 30): 0.75, ("groth16", "node", 60): 1.15, ("groth16", "node", 120): 2.21,
           ("groth16", "browser", 30): 0.85, ("groth16", "browser", 60): 1.25, ("groth16", "browser", 120): 2.41,
           ("plonk", "node", 30): 162.6, ("plonk", "node", 60): 327.0, ("plonk", "node", 120): 705.6,
           ("plonk", "browser", 30): 147.5, ("plonk", "browser", 60): 397.9}
    rmax = {("groth16", "node", 30): 0.66, ("groth16", "node", 60): 0.86, ("groth16", "node", 120): 0.91,
            ("groth16", "browser", 30): 0.58, ("groth16", "browser", 60): 0.80, ("groth16", "browser", 120): 0.82}
    assert set(p50) == set(d), set(d) ^ set(p50)
    for k, v in p50.items():
        got = st.median(d[k])
        dec = 2 if k[0] == "groth16" else 1
        assert round(got, dec) == v, (k, got, v)
    for k, v in rmax.items():
        got = (k[2] / 60) / st.mean(d[k])
        assert abs(got - v) < 0.0051, (k, got, v)
    print("redraw matches bench/RESULTS.md: 11 prove p50 values, 6 Groth16 r_max values")


def set_x(ax):
    ax.set_xscale("log")
    ax.set_xticks(NS)
    ax.set_xticklabels(["N = 30\n(0.5 s)", "N = 60\n(1 s)", "N = 120\n(2 s)"])
    ax.minorticks_off()
    ax.set_xlim(26, 138)
    ax.tick_params(axis="x", length=2, pad=2)
    ax.grid(axis="y", color=GRID, linewidth=0.4)
    ax.set_axisbelow(True)


def series_handles(extra):
    h = [Line2D([], [], color=c, marker=m, linestyle=ls, linewidth=1.3, markersize=4, label=lab)
         for _, _, c, m, ls, lab in SERIES]
    return h + extra


def prove_time(d):
    fig, ax = plt.subplots(figsize=(3.5, 2.25), layout="constrained")
    set_x(ax)
    for scheme, env, c, m, ls, _ in SERIES:
        xs = [n for n in NS if (scheme, env, n) in d]
        ys = [st.median(d[(scheme, env, n)]) for n in xs]
        lo = [pct(d[(scheme, env, n)], 0.05) for n in xs]
        hi = [pct(d[(scheme, env, n)], 0.95) for n in xs]
        ax.fill_between(xs, lo, hi, color=c, alpha=0.18, linewidth=0)
        ax.plot(xs, ys, color=c, marker=m, linestyle=ls, linewidth=1.3, markersize=4,
                markeredgecolor="white", markeredgewidth=0.4)
    play = [n / 60 for n in NS]
    ax.plot(NS, play, color=INK, linestyle="--", linewidth=0.9)
    ax.set_yscale("log")
    ax.set_ylim(0.3, 2500)
    ax.set_yticks([1, 10, 100, 1000])
    ax.set_yticklabels(["1", "10", "100", "1000"])
    ax.set_ylabel("Prove time p50 (s), log scale")
    h = series_handles([Line2D([], [], color=INK, linestyle="--", linewidth=0.9, label="Play time, N / 60 s")])
    ax.legend(handles=h, loc="center left", bbox_to_anchor=(0.0, 0.5), ncol=2, columnspacing=0.8,
              handlelength=2.0, labelspacing=0.25)
    fig.savefig(HERE / "prove-time.pdf")
    plt.close(fig)


def r_max(d):
    fig, ax = plt.subplots(figsize=(3.5, 1.95), layout="constrained")
    set_x(ax)
    for scheme, env, c, m, ls, _ in SERIES:
        xs = [n for n in NS if (scheme, env, n) in d]
        ys = [(n / 60) / st.mean(d[(scheme, env, n)]) for n in xs]
        ax.plot(xs, ys, color=c, marker=m, linestyle=ls, linewidth=1.3, markersize=4,
                markeredgecolor="white", markeredgewidth=0.4)
    ax.axhline(1, color=INK, linestyle="--", linewidth=0.9)
    ax.set_yscale("log")
    ax.set_ylim(0.0015, 1.6)
    ax.set_yticks([0.01, 0.1, 1])
    ax.set_yticklabels(["0.01", "0.1", "1"])
    ax.set_ylabel(r"$r_{\max}$, log scale")
    h = series_handles([Line2D([], [], color=INK, linestyle="--", linewidth=0.9,
                               label="Every window proven live")])
    ax.legend(handles=h, loc="center left", bbox_to_anchor=(0.0, 0.47), ncol=2, columnspacing=0.8,
              handlelength=2.0, labelspacing=0.25)
    fig.savefig(HERE / "r-max.pdf")
    plt.close(fig)


def box(ax, x, y, w, h, text, fc="#ffffff", ec="#555555", size=6.3, weight="normal"):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.6",
                                fc=fc, ec=ec, linewidth=0.6, zorder=2))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=size, color=INK,
            zorder=3, weight=weight, linespacing=1.05)


def arrow(ax, a, b, color="#333333", ls="-"):
    ax.annotate("", xy=b, xytext=a, zorder=1,
                arrowprops=dict(arrowstyle="-|>", color=color, lw=0.7, ls=ls, mutation_scale=6,
                                shrinkA=0, shrinkB=0))


def architecture():
    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    fig.subplots_adjust(0, 0, 1, 1)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 74)
    ax.axis("off")
    # trust regions
    ax.add_patch(FancyBboxPatch((0.4, 0.6), 36, 72.8, boxstyle="round,pad=0,rounding_size=1",
                                fc="#eaf2fb", ec=GROTH, linewidth=0.7))
    ax.add_patch(FancyBboxPatch((63.6, 0.6), 36, 72.8, boxstyle="round,pad=0,rounding_size=1",
                                fc="#fdeee8", ec=PLONK, linewidth=0.7))
    ax.text(18.4, 70.3, "Browser client", ha="center", va="center", fontsize=7.2, weight="bold", color=INK)
    ax.text(81.6, 70.3, "Authoritative server", ha="center", va="center", fontsize=7.2, weight="bold", color=INK)
    # client
    cx, cw = 3, 31
    box(ax, cx, 57, cw, 10, "Game simulation\n(integer state)")
    box(ax, cx, 41, cw, 10, "WindowRecorder\n(hidden state, salts)")
    box(ax, cx, 25, cw, 10, "Proof queue")
    box(ax, cx, 4, cw, 14, "Web Worker prover\n(snarkjs: witness,\nGroth16 proof)", fc="#d6e6f8")
    arrow(ax, (18.5, 57), (18.5, 51))
    arrow(ax, (18.5, 41), (18.5, 35))
    arrow(ax, (18.5, 25), (18.5, 18))
    # server
    sx, sw = 66, 31
    box(ax, sx, 57, sw, 10, "MatchRoom: hits, damage;\nDigestBuilder", size=5.8)
    box(ax, sx, 25, sw, 26, "ProofTracker\n\nstores commitments,\ndraws challenges,\nchecks bind, digest and\ncommitments; audit,\nverdict", size=5.8)
    box(ax, sx, 4, sw, 14, "Verifier pool\n(worker threads,\nsnarkjs verify)", fc="#fbd9cb")
    arrow(ax, (81.5, 57), (81.5, 51))
    arrow(ax, (77.5, 25), (77.5, 18))
    arrow(ax, (85.5, 18), (85.5, 25))

    # wire
    def wire(a, b, y, label, ls="-"):
        arrow(ax, (a, y), (b, y), ls=ls)
        ax.text(47 if label == "window_proof" else 50, y + 0.9, label, ha="center", va="bottom", fontsize=5.9, color=INK,
                family="DejaVu Sans Mono")
    wire(34, 66, 62, "input_snapshot")
    wire(34, 66, 46, "window_commit")
    wire(66, 34, 30, "challenge")
    wire(34, 66, 13.5, "window_proof")
    ax.plot([66, 60, 60], [27, 27, 7], color="#333333", lw=0.7, zorder=1)
    arrow(ax, (60, 7), (34, 7))
    ax.text(47, 7.9, "proof_result", ha="center", va="bottom", fontsize=5.9, color=INK,
            family="DejaVu Sans Mono")
    ax.text(50, 70.3, "public data only", ha="center", va="center", fontsize=5.9, color=MUTED, style="italic")
    fig.savefig(HERE / "architecture.pdf")
    plt.close(fig)


def screenshot_crop():
    src = SHOTS / "run1-results-cheater.png"
    shutil.copy2(src, HERE / "source" / src.name)
    im = Image.open(src).convert("RGB")
    assert im.size == (1009, 932), im.size
    x0, x1 = 150, 875
    bands = [(105, 226), (405, 558), (678, 766)]  # verdict; own audit to spot-checks; proof strips
    gap = 5
    h = sum(b - a for a, b in bands) + gap * (len(bands) - 1)
    out = Image.new("RGB", (x1 - x0, h), (120, 120, 120))
    y = 0
    for a, b in bands:
        out.paste(im.crop((x0, a, x1, b)), (0, y))
        y += b - a + gap
    out.save(HERE / "results-crop.png", dpi=(207, 207), optimize=True)


def copy_sources():
    (HERE / "source").mkdir(exist_ok=True)
    for p in (OUT / "charts").glob("*.png"):
        shutil.copy2(p, HERE / "source" / p.name)


def main():
    copy_sources()
    d = load()
    check_against_results(d)
    prove_time(d)
    r_max(d)
    architecture()
    screenshot_crop()


if __name__ == "__main__":
    main()

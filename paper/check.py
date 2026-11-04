#!/usr/bin/env python3
"""Pre-submission checks for paper/main.tex. Exit code 0 only if everything passes.

  1. every \\cite key exists in refs.bib (and every refs.bib entry is cited)
  2. every body line with a number has a "% src:" comment naming allowed source file(s)
  3. every numeric token on such a line literally occurs in a file that line names
  4. main.log has no overfull \\hbox/\\vbox, undefined citation or undefined reference
  5. main.pdf has <= 6 pages, no "??", no leftover "[?]"
  6. abstract <= 200 words

Usage: python paper/check.py [--pdf-lib DIR]   (DIR holds PyMuPDF if not installed globally)
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEX = (HERE / "main.tex").read_text(encoding="utf-8")
BIB = (HERE / "refs.bib").read_text(encoding="utf-8")
LOG = HERE / "build" / "main.log"
PDF = HERE / "main.pdf"

# The user's allowed sources, plus (second block) the files that had to be named explicitly because
# the fact is not in the first block. The second block is reported, never silently accepted.
ALLOWED = {
    "bench/RESULTS.md",
    "docs/REPORT.md",
    "bench/out/detection.csv",
    "bench/out/results.csv",
    "bench/out/screenshots/cheat-test-2026-10-23/README.md",
    "bench/out/screenshots/cheat-test-both-2026-10-23/README.md",
}
EXTRA = {"docs/ARCHITECTURE.md", "docs/CHANGELOG.md", "docs/SECURITY.md"}
ALIASES = {
    "RESULTS": "bench/RESULTS.md",
    "REPORT": "docs/REPORT.md",
    "DETECTION": "bench/out/detection.csv",
    "BENCHCSV": "bench/out/results.csv",
    "CHEAT": "bench/out/screenshots/cheat-test-2026-10-23/README.md",
    "CHEATBOTH": "bench/out/screenshots/cheat-test-both-2026-10-23/README.md",
    "ARCH": "docs/ARCHITECTURE.md",
    "CHANGELOG": "docs/CHANGELOG.md",
    "SECURITY": "docs/SECURITY.md",
}
WORDS = r"\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty)\b"
errors, notes = [], []


def strip_comment(line):
    m = re.search(r"(?<!\\)%", line)
    return (line, "") if not m else (line[: m.start()], line[m.start() + 1 :])


def scrub(code):
    """Remove things whose digits are not claims: labels, cites, graphics, sizes, identifiers."""
    code = re.sub(r"\\(label|ref|cite|includegraphics(\[[^\]]*\])?|bibliography\w*|begin|end|url|Cref)\{[^}]*\}", " ", code)
    code = re.sub(r"\\begin\{\w+\*?\}(\[[^\]]*\])?(\{[^}]*\})*", " ", code)
    code = re.sub(r"\\(cline|cmidrule|multicolumn|multirow)(\([^)]*\))?\{[^}]*\}(\{[^}]*\})?", " ", code)
    code = re.sub(r"-?\d*\.?\d+(in|pt|em|ex|cm|mm)\b", " ", code)
    code = re.sub(r"\\[a-zA-Z]+\d*", " ", code)
    # names that contain digits but are not quantities
    code = re.sub(r"1v1|Groth16|groth16\\?_?\d*|plonk\\?_?\d*|BN254|SHA-256|p50|p95|p5|r1cs|R1CS|O2", " ", code)
    code = re.sub(r"\bw(\d+)", r"\1", code)
    return code


body = TEX[TEX.index(r"\begin{document}") :]
sources_cache = {}


def source_text(path):
    if path not in sources_cache:
        sources_cache[path] = (ROOT / path).read_text(encoding="utf-8", errors="replace").replace(",", "")
    return sources_cache[path]


# ---- 1. cite keys
cited = set()
for group in re.findall(r"\\cite\{([^}]*)\}", re.sub(r"(?m)(?<!\\)%.*$", "", body)):
    cited.update(k.strip() for k in group.split(","))
bibkeys = set(re.findall(r"@\w+\{\s*([^,\s]+)\s*,", BIB))
for k in sorted(cited - bibkeys):
    errors.append(f"cite key not in refs.bib: {k}")
for k in sorted(bibkeys - cited):
    errors.append(f"refs.bib entry never cited: {k}")

# ---- 2 + 3. numbers need a source, and must occur in it
checked_tokens, numbered_lines = 0, 0
extra_used = {}
start_line = TEX[: TEX.index(r"\begin{document}")].count("\n") + 1
in_preamble_like = False
for lineno, raw in enumerate(TEX.splitlines()[start_line:], start_line + 1):
    code, comment = strip_comment(raw)
    if not code.strip():
        continue
    clean = scrub(code)
    tokens = re.findall(r"\d+(?:,\d{3})*(?:\.\d+)?", clean)
    has_words = re.search(WORDS, re.sub(r"\\[a-zA-Z]+", " ", code), re.I)
    if not tokens and not has_words:
        continue
    numbered_lines += 1
    m = re.search(r"src:\s*(.+)$", comment)
    if not m:
        errors.append(f"line {lineno}: number without % src: comment: {code.strip()[:90]}")
        continue
    if "formula" in m.group(1) or "n/a" in m.group(1):
        continue  # mathematical constants in a formula, or structural counts with no measured value
    names = [ALIASES.get(n.strip(), n.strip()) for n in re.split(r"[;]", m.group(1)) if n.strip()]
    bad = [n for n in names if n not in ALLOWED | EXTRA]
    if bad:
        errors.append(f"line {lineno}: unknown source {bad}")
        continue
    for n in names:
        if n in EXTRA:
            extra_used.setdefault(n, []).append(lineno)
    texts = "\n".join(source_text(n) for n in names)
    for t in tokens:
        checked_tokens += 1
        tok = t.replace(",", "")
        if not re.search(r"(?<![\d.])" + re.escape(tok) + r"(?!\d)", texts):
            errors.append(f"line {lineno}: {t} not found in {names}")

# ---- 4. log
if LOG.exists():
    log = LOG.read_text(encoding="utf-8", errors="replace")
    overfull = re.findall(r"^Overfull \\[hv]box.*$", log, re.M)
    underfull = re.findall(r"^Underfull \\[hv]box.*$", log, re.M)
    for o in overfull:
        errors.append("log: " + o)
    for pat in (r"Citation `[^']+' .*undefined", r"Reference `[^']+' .*undefined", r"Label\(s\) may have changed"):
        for o in re.findall(pat, log):
            errors.append("log: " + o)
    notes.append(f"underfull boxes (not margin overruns): {len(underfull)}")
else:
    errors.append(f"missing {LOG}")

# ---- 5. PDF
for i, a in enumerate(sys.argv):
    if a == "--pdf-lib":
        sys.path.insert(0, sys.argv[i + 1])
import fitz  # noqa: E402

if PDF.exists():
    doc = fitz.open(PDF)
    text = "\n".join(p.get_text() for p in doc)
    if len(doc) > 6:
        errors.append(f"PDF has {len(doc)} pages (max 6)")
    if "??" in text:
        errors.append("PDF contains ??")
    if re.search(r"\[\?\]", text):
        errors.append("PDF contains [?]")
    for p in doc:
        w = p.rect.width
        margin = 0.5 * 72  # nothing printed within half an inch of the page edge
        for b in p.get_text("blocks"):
            if b[0] < margin or b[2] > w - margin:
                errors.append(f"p{p.number + 1}: text outside margins at x={b[0]:.0f}-{b[2]:.0f}: {b[4][:40]!r}")
    nonembedded = {f[3] for p in doc for f in p.get_fonts(full=True) if f[1] == "n/a" or not f[3]}
    notes.append(f"pages: {len(doc)}; PDF words: {len(text.split())}; non-embedded fonts: {sorted(nonembedded) or 'none'}")
else:
    errors.append("missing main.pdf")

# ---- 6. abstract
ab = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", TEX, re.S).group(1)
ab = re.sub(r"(?m)(?<!\\)%.*$", "", ab)
ab = re.sub(r"\\[a-zA-Z]+\{([^}]*)\}", r"\1", ab)
words = len(ab.split())
notes.append(f"abstract words: {words}")
if words > 200:
    errors.append(f"abstract has {words} words (max 200)")

print(f"cite keys: {len(cited)} cited, {len(bibkeys)} in refs.bib")
print(f"lines with numbers: {numbered_lines}; numeric tokens traced to a named source: {checked_tokens}")
for n, lines in sorted(extra_used.items()):
    print(f"OUTSIDE the agreed source list: {n} (lines {', '.join(map(str, lines))})")
for n in notes:
    print(n)
for e in errors:
    print("FAIL", e)
print("RESULT:", "FAIL" if errors else "PASS")
sys.exit(1 if errors else 0)

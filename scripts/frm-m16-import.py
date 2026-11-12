#!/usr/bin/env python3
"""Import the NPCI EFRM M16 model sheet (csv) into docs/npci-frm/.

Usage:  python3 -I scripts/frm-m16-import.py "docs/npci-frm/M16 EFRM - M16 - As on 10th Oct 2026.csv"

Expects header: Sr. No. | Risk Score | Category | Description | M16 NPCI Error code | Explanation.
NPCI lists the code as MOM-<risk score>; the switch records the decline as M16-<risk score>
(e.g. MOM-01278 → M16-01278), so both are kept.
Writes:
  docs/npci-frm/m16-rules.json   machine data — read by backend/frmRules.js (dashboard decline
                                 descriptions) and backend/specSearch.js (exact-code lookup)
  docs/npci-frm/m16-NN-*.md      one section per model, indexed by Spec Search / RAG
  docs/npci-frm/m16-README.md    index (master list table)
Stdlib only. `<!-- p.N -->` markers carry the sheet row number N (header = row 1).
"""
import csv
import datetime
import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "npci-frm"

# Code ranges per Markdown part (by risk score).
PARTS = [
    (0, 1239, "M16-00001 – M16-01239"),
    (1240, 1279, "M16-01240 – M16-01279"),
    (1280, 99999, "M16-01280 and above"),
]


def clean(s):
    return re.sub(r"[ \t]+", " ", str(s or "")).strip()


def one_line(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def as_of(name):
    """'M16 EFRM - M16 - As on 10th Oct 2026.csv' → ('2026-10-10', '10 Oct 2026')."""
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\s+(\d{4})", name)
    if not m:
        return "", ""
    d = datetime.datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%d %b %Y").date()
    return d.isoformat(), d.strftime("%-d %b %Y")


def main(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    head = [h.strip().lower() for h in rows[0]]
    try:
        col = {k: head.index(k) for k in ("sr. no.", "risk score", "category", "description", "m16 npci error code", "explanation")}
    except ValueError:
        sys.exit(f"Unexpected header: {rows[0]}")

    rules = []
    for n, r in enumerate(rows[1:], 2):
        get = lambda k: r[col[k]] if col[k] < len(r) else ""
        sheet_code = one_line(get("m16 npci error code")).upper()
        m = re.match(r"^[A-Z]{3}-(\d{5})$", sheet_code)
        if not m:
            continue
        rules.append(
            {
                "code": f"M16-{m.group(1)}",
                "sheetCode": sheet_code,
                "riskScore": int(one_line(get("risk score")) or m.group(1)),
                "category": one_line(get("category")),
                "rule": one_line(get("description")),
                # Explanations are multi-line lists ("1) … 2) …"); keep the line breaks.
                "desc": "\n".join(clean(x) for x in str(get("explanation")).splitlines() if x.strip()),
                "row": n,
            }
        )
    date, label = as_of(Path(path).name)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("m16-[0-9][0-9]-*.md"):
        old.unlink()

    data = {
        "source": Path(path).name,
        "title": f"NPCI EFRM M16 models ({label})" if label else "NPCI EFRM M16 models",
        "family": "M16",
        "month": date[:7],
        "asOf": date,
        "importedAt": datetime.date.today().isoformat(),
        "count": len(rules),
        "rules": rules,
    }
    (OUT / "m16-rules.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")

    part_rows = []
    for i, (lo, hi, rng) in enumerate(PARTS, 1):
        sel = sorted((x for x in rules if lo <= x["riskScore"] <= hi), key=lambda x: x["code"])
        if not sel:
            continue
        name = f"m16-{i:02d}-{lo:05d}.md"
        lines = [
            f"# NPCI EFRM M16 Models ({label}) — {rng}",
            "",
            f"Source: `{data['source']}` · {len(sel)} models · decline code `M16` (AI MODEL DECLINE, BD — "
            "NPCI EFRM fraud model) with the model risk score as suffix; NPCI sheet code `MOM-<score>`. "
            "`p.N` = sheet row N. Index: [M16 master list](m16-README.md).",
            "",
            "---",
            "",
        ]
        for x in sel:
            body = x["desc"].replace("\n", "  \n")
            lines += [
                f"<!-- p.{x['row']} -->",
                "",
                f"### {x['code']} · {x['rule']}",
                "",
                f"**Decline:** `{x['code']}` (M16 AI model decline, BD) · **NPCI code:** `{x['sheetCode']}` · "
                f"**Risk score:** {x['riskScore']} · **Category:** {x['category']}",
                "",
                body,
                "",
            ]
        lines.append("---")
        (OUT / name).write_text("\n".join(lines) + "\n")
        part_rows.append(f"| {i:02d} | [{rng}]({name}) | {len(sel)} |")

    cell = lambda s: one_line(s).replace("|", "\\|")
    table = [f"| `{x['code']}` | `{x['sheetCode']}` | {x['category']} | {cell(x['rule'])} |" for x in sorted(rules, key=lambda x: x["code"])]
    cats = {}
    for x in rules:
        cats[x["category"]] = cats.get(x["category"], 0) + 1
    idx = [
        f"# NPCI EFRM M16 Models — master list ({label})",
        "",
        f"Source: `{data['source']}` (NPCI, {len(rules)} models: "
        + ", ".join(f"{k} {v}" for k, v in sorted(cats.items(), key=lambda kv: -kv[1]))
        + f"). Imported {data['importedAt']} with `scripts/frm-m16-import.py`.",
        "",
        "Each entry is an NPCI EFRM fraud-detection model (mule / task-fraud / graph / HawkEye / Fusion …). A transaction "
        "a model flags is declined with UPI error **M16 — AI MODEL DECLINE (BD)** and the switch records the code "
        "as `M16-<risk score>`, e.g. `M16-01278`. NPCI's sheet writes the same code as `MOM-01278`.",
        "Related: [U16 FRM rules](README.md) · [Error and Response Codes V2.9](../npci-error-codes/README.md) · "
        "[NPCI UPI TSD V1.0](../npci-tsd/README.md).",
        "",
        "Cite as **(NPCI EFRM M16, " + label + ", M16-xxxxx)**.",
        "",
        "## Parts",
        "",
        "| # | Codes | Models |",
        "|---|---|---|",
        *part_rows,
        "",
        "## Master list",
        "",
        "| Switch code | NPCI code | Category | Model |",
        "|---|---|---|---|",
        *table,
        "",
        "## Where it is used",
        "",
        "- **Dashboards:** `backend/frmRules.js` reads `m16-rules.json`; `M16-xxxxx` decline codes show the model name and "
        "explanation in Unified SR (`/#srdash`) and Product Wise (`/#product`).",
        "- **Utilities:** Error Definition (`M16-01278` or `MOM-01278`) and Spec Search (`/#utilities?spec=M16-01278`); "
        "`/api/spec/context?q=M16-01278&format=text` and the PRD/BRD/UAT/JIRA agents' RAG get the model.",
        "",
        "## Notes",
        "",
        "- To refresh: copy the new sheet (csv) into this folder and re-run the import; dashboards and search pick it up "
        "without a restart.",
        "",
    ]
    (OUT / "m16-README.md").write_text("\n".join(idx))
    print(f"{len(rules)} models → {OUT} ({len(part_rows)} parts, as of {date})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

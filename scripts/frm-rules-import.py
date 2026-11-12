#!/usr/bin/env python3
"""Import an NPCI FRM rules sheet (xlsx) into docs/npci-frm/.

Usage:  python3 -I scripts/frm-rules-import.py docs/npci-frm/NPCI-FRM_Rules-Oct2026.xlsx

Expects one sheet with header row: Error code | Rule Name | Description | Rule Owner | Status | Month.
Writes:
  docs/npci-frm/frm-rules.json   machine data — read by backend/frmRules.js (dashboard decline
                                 descriptions) and backend/specSearch.js (exact-code lookup)
  docs/npci-frm/NN-*.md          one section per rule, indexed by Spec Search / RAG
  docs/npci-frm/README.md        index
Stdlib only (no openpyxl). `<!-- p.N -->` markers carry the sheet row number N.
"""
import datetime
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
OUT = Path(__file__).resolve().parent.parent / "docs" / "npci-frm"

# Code ranges per Markdown part (by U16 rule number).
PARTS = [
    (0, 799, "U16-00001 – U16-00799"),
    (800, 999, "U16-00800 – U16-00999"),
    (1000, 1099, "U16-01000 – U16-01099"),
    (1100, 1199, "U16-01100 – U16-01199"),
    (1200, 1399, "U16-01200 – U16-01399"),
    (1400, 99999, "U16-01400 and above"),
]


def read_rows(xlsx):
    z = zipfile.ZipFile(xlsx)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    rows = []
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(f"{{{NS['m']}}}row"):
        r = {"_row": int(row.get("r"))}
        for c in row.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", NS)
            t = c.get("t")
            if t == "inlineStr":
                r[col] = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
            elif v is not None:
                r[col] = shared[int(v.text)] if t == "s" else v.text
        rows.append(r)
    return rows


def clean(s):
    """The sheet stores commas as semicolons: 'Rs.1; 00; 000' → 'Rs.1,00,000', '6211;  5960' → '6211, 5960'."""
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    s = re.sub(r"(\d); (\d{2,3})(?!\d)", r"\1,\2", s)
    s = re.sub(r"(\d); (\d{2,3})(?!\d)", r"\1,\2", s)  # second pass for 1; 00; 000
    return re.sub(r"\s*;\s*", ", ", s)


def month_of(v):
    try:  # Excel serial date
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(v)))).strftime("%Y-%m")
    except (TypeError, ValueError):
        return str(v or "")


def md_cell(s):
    return s.replace("|", "\\|")


def main(xlsx):
    rows = read_rows(xlsx)
    head = [str(rows[0].get(c, "")).strip().lower() for c in "ABCDEF"]
    if not head[0].startswith("error code") or not head[1].startswith("rule"):
        sys.exit(f"Unexpected header: {head}")
    rules = []
    for r in rows[1:]:
        code = str(r.get("A", "")).strip().upper()
        if not re.match(r"^U16-\d{5}$", code):
            continue
        rules.append(
            {
                "code": code,
                "rule": clean(r.get("B")),
                "desc": clean(r.get("C")),
                "owner": clean(r.get("D")),
                "status": clean(r.get("E")).upper(),
                "month": month_of(r.get("F")),
                "row": r["_row"],
            }
        )
    months = sorted({x["month"] for x in rules})
    month = months[-1] if months else ""
    label = datetime.datetime.strptime(month, "%Y-%m").strftime("%b %Y") if month else ""
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("[0-9][0-9]-*.md"):
        old.unlink()

    data = {
        "source": Path(xlsx).name,
        "title": f"NPCI FRM rules ({label})",
        "month": month,
        "importedAt": datetime.date.today().isoformat(),
        "count": len(rules),
        "rules": rules,
    }
    (OUT / "frm-rules.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")

    part_rows = []
    for i, (lo, hi, rng) in enumerate(PARTS, 1):
        sel = sorted((x for x in rules if lo <= int(x["code"][4:]) <= hi), key=lambda x: (x["code"], x["row"]))
        if not sel:
            continue
        name = f"{i:02d}-u16-{lo:05d}.md"
        lines = [
            f"# NPCI FRM Rules ({label}) — {rng}",
            "",
            f"Source: `{data['source']}` · {len(sel)} rules · decline code `U16` (RISK THRESHOLD EXCEEDED, BD) "
            "with the NPCI EFRM rule number as suffix. `p.N` = sheet row N. Index: [README](README.md).",
            "",
            "---",
            "",
        ]
        for x in sel:
            lines += [
                f"<!-- p.{x['row']} -->",
                "",
                f"### {x['code']} · {x['rule']}",
                "",
                f"**Decline:** `{x['code']}` (U16 risk threshold exceeded, BD) · **Owner:** {x['owner']} · "
                f"**Status:** {x['status']} · **Month:** {x['month']}",
                "",
                x["desc"],
                "",
            ]
        lines.append("---")
        (OUT / name).write_text("\n".join(lines) + "\n")
        part_rows.append(f"| {i:02d} | [{rng}]({name}) | {len(sel)} |")

    dup = sorted({x["code"] for x in rules if sum(1 for y in rules if y["code"] == x["code"]) > 1})
    idx = [
        f"# NPCI FRM Rules — active list ({label})",
        "",
        f"Source: `{data['source']}` (NPCI, {len(rules)} rules, all owner NPCI, status as in sheet). "
        f"Imported {data['importedAt']} with `scripts/frm-rules-import.py`.",
        "",
        "Each rule is an NPCI EFRM (enterprise fraud risk management) check. A transaction it declines fails with "
        "UPI error **U16 — RISK THRESHOLD EXCEEDED (BD)** and the switch records the code as `U16-<rule no.>`, "
        "e.g. `U16-00972`.",
        "Related: [Error and Response Codes V2.9](../npci-error-codes/README.md) · "
        "[NPCI UPI TSD V1.0](../npci-tsd/README.md) · [Consolidated Circular V1.0](../npci-circular/README.md).",
        "M16 (AI MODEL DECLINE) EFRM models: [M16 master list](m16-README.md) (`M16-<risk score>`, `scripts/frm-m16-import.py`).",
        "",
        "Cite as **(NPCI FRM Rules, " + label + ", U16-xxxxx)**.",
        "",
        "## Parts",
        "",
        "| # | Codes | Rules |",
        "|---|---|---|",
        *part_rows,
        "",
        "## Where it is used",
        "",
        "- **Dashboards:** `backend/frmRules.js` reads `frm-rules.json`; `U16-xxxxx` decline codes show the rule name and "
        "description in Unified SR (`/#srdash`) and Product Wise (`/#product`).",
        "- **Spec Search / agents:** `U16-00972` in Spec Search (`/#utilities?spec=U16-00972`), "
        "`/api/spec/context?q=U16-00972&format=text`, and the PRD/BRD/UAT/JIRA agents' RAG get the rule.",
        "",
        "## Notes",
        "",
        "- The sheet stores commas as semicolons (`Rs.1; 00; 000`); the import turns them back into commas.",
        f"- Codes shared by several rules: {', '.join(f'`{c}`' for c in dup) or 'none'} (all rules listed).",
        "- To refresh: copy the new sheet into this folder and re-run the import; the dashboards and search pick it up "
        "without a restart.",
        "",
    ]
    (OUT / "README.md").write_text("\n".join(idx))
    print(f"{len(rules)} rules → {OUT} ({len(part_rows)} parts, month {month})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

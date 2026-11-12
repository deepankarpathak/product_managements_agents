# knowledge/data-sources/INDEX.md

**Purpose:** Sub-routing for data-source discoveries. Every source has a one-line "what it answers" + a pointer to its folder.

---

## trino-dwh/
**What it answers:** UPI TPAP success rate by payer bank, payee PSP, handle, flow, instrument and NPCI/app response code, from raw switch snapshots (`switch.*_snapshot_v3`) and day-level Looker tables (`team_product.LOOKER_*`).
**Connection:** see trino-dwh/connection.md (runner: `node scripts/trino-run.mjs`)
**Files:** connection.md, schema.md, queries.md, gotchas.md

## redash-switch-db/  (live, ≤4h windows)
**What it answers:** Same SR questions for the last few hours, straight from the live switch DB (MySQL) through Redash.
**Connection:** Claude Code Redash MCP (`redash-ptybl`, `list_data_sources` then `execute_adhoc_query`). Mark as **TBD** until a folder with the four files is written; use only after confirming the data source id with the PM.
**Files:** not yet written

---

## Folder Convention

Every source folder has exactly four files: `connection.md`, `schema.md`, `queries.md`, `gotchas.md`. New sources follow `REGISTER.md` (seven-question protocol).

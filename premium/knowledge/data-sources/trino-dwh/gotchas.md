# trino-dwh — gotchas

## Mandatory filters (raw `switch.*` tables)
Missing any of these silently returns wrong SR. Mirrors the dashboard's own base query.

- `dl_last_updated >= DATE '<from>'` (partition pruning; also on the participants table)
- `created_on >= TIMESTAMP '<from>' AND created_on < TIMESTAMP '<to>'` (IST, half-open)
- `business_type IS NULL`
- `type IN ('PAY','COLLECT')`
- `category IN ('VPA2VPA','VPA2ACCOUNT','VPA2MERCHANT')`
- `psp_handle IN (<handles in scope>)`
- Participants: `participant_type = 'PAYER'` for payer bank; pad the created_on window by a few minutes on the participants side.

## Day tables
- `team_product.LOOKER_TPAP_Txns_V3`: filter `dt >= DATE .. AND dt < DATE ..`; complete days only.
- Same-day numbers must come from the raw `switch.*` tables, not the Looker table.

## Tool quirks
- Trino SQL (not MySQL). Timestamps in `created_on` are IST as stored.
- One shared service account, small queue: avoid fan-out of many parallel queries; the runner serialises with the dashboards' cap.
- Live intraday (≤4h) comes from the switch DB via Redash (MySQL), not Trino. In Claude Code use the Redash MCP; MySQL dialect, `FORCE INDEX (PRIMARY)` + id bounds are needed to keep it fast.

## Product traps
- SR is only comparable like-for-like: same handle set, same flow, same window length vs baseline (yesterday vs L7D, or MTD vs LMTD).
- A bank's SR drop with a rising **BD** share is usually customer-side (insufficient funds etc.), not a bank fault. TD / RD rises are the ones to escalate.
- Check `udash-annotations` (brief lists them) before concluding: an NPCI circular or bank downtime may already explain it.
- Risk codes: see the project memory note on U16-00972 / U16-01128 / U16-01129 before treating these as bank faults.

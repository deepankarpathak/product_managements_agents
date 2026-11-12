# trino-dwh — connection

## Purpose
Answers payer-bank / payee-PSP success-rate (SR) questions for UPI TPAP traffic: which bank, handle, flow, instrument or error code moved SR, and by how much. Example questions: "Why did SBIN payer SR drop yesterday vs L7D?", "Which NPCI response codes rose for HDFC on P2M?"

## Runner
`node scripts/trino-run.mjs [--out file.json] "<SELECT ...>"` (run from the `premium/` folder).
Reuses `backend/trinoClient.js` and `prd-agent/.env` (`TRINO_API_URL`, `TRINO_SERVICE_USER`, `TRINO_SERVICE_PASSWORD`). Read-only: the script refuses anything but one SELECT / WITH / SHOW / DESCRIBE. Credentials are local to this machine.

## Access
Shared service account with a small queue; the script waits and retries on "Too many queued queries". Keep queries narrow (date + handle filters). Not usable without VPN / corp network access to `TRINO_API_URL`.

## Freshness
Snapshot tables (`switch.*_snapshot_v3`) lag; use the partition filter `dl_last_updated` and expect the latest hour or two to be incomplete. `team_product.LOOKER_*` tables are day-level, complete days only (D-1 latest).

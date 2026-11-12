-- Automatic Payments Dashboard · Interop · Port-Out failures by code
-- Failed purpose BC UPDATEs on another app's UMN (same rule as 06), by response code = npci_resp_code, else app_resp_code.
-- Count = distinct new UMNs per day.
-- Dates {start} .. {end} both included (the dashboard fills in the chosen days; for the 'Till date' column use start 2025-12-23).
-- Run on Trino (catalog hive): TRINO_CATALOG=hive python3 ~/trino/run_trino_query.py --file <this file>
WITH t AS (
  SELECT txn_id, org_txn_id, umn, status, DATE(created_on) AS dt,
         lower(substring(umn, position('@' IN umn) + 1)) AS other_handle,
         coalesce(npci_resp_code, app_resp_code, status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type = 'UPDATE' AND json_extract_scalar(extended_info, '$.purpose') = 'BC'
    AND status IN ('SUCCESS', 'FAILURE')
    AND substring(umn, position('@' IN umn) + 1) NOT IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
-- payer bank: the original Paytm mandate's PAYER leg (a successful port-out has no PAYER leg of its own); failures fall back to their own leg
p AS (
  SELECT txn_id, max(bank_code) AS bank
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '2020-01-01' AND participant_type = 'PAYER'
    AND (txn_id IN (SELECT txn_id FROM t) OR txn_id IN (SELECT org_txn_id FROM t))
  GROUP BY txn_id
),
base AS (
  SELECT t.dt, t.status, t.umn, t.code, coalesce(po.bank, ps.bank, 'NA') AS payer_bank, t.other_handle
  FROM t LEFT JOIN p po ON po.txn_id = t.org_txn_id LEFT JOIN p ps ON ps.txn_id = t.txn_id
)
SELECT dt, code, COUNT(DISTINCT umn) AS failures
FROM base
WHERE status = 'FAILURE'
GROUP BY GROUPING SETS ((dt), (dt, code))   -- code NULL = all failures
ORDER BY dt, failures DESC

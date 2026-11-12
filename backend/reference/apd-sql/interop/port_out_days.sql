-- Interop panel · Port-Out by day (Automatic Payments Dashboard). Days {start} (incl.) to {end} (excl.).
-- Port-Out from Paytm = switch.txn_info_snapshot_v3 business_type MANDATE, type UPDATE, extended_info purpose BC, UMN on another app's handle
-- (same rule as port_cohort.sql). org_txn_id = the original Paytm mandate:
--   bank = its PAYER leg bank_code (the port-out txn itself has no PAYER leg when it succeeds; failures fall back to their own PAYER leg)
--   paytm_handle = handle of the original Paytm UMN · other_handle = handle of the new UMN at the other app.
-- n = distinct new UMNs per day; code = npci_resp_code, else app_resp_code (failures only).
WITH t AS (
  SELECT txn_id, org_txn_id, umn, status, DATE(created_on) AS dt, lower(substring(umn, position('@' IN umn) + 1)) AS other_handle,
         coalesce(npci_resp_code, app_resp_code, status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00'
    AND business_type = 'MANDATE' AND type = 'UPDATE' AND json_extract_scalar(extended_info, '$.purpose') = 'BC'
    AND status IN ('SUCCESS', 'FAILURE')
    AND substring(umn, position('@' IN umn) + 1) NOT IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
p AS (
  SELECT txn_id, max(bank_code) AS bank FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '2020-01-01' AND participant_type = 'PAYER' AND (txn_id IN (SELECT txn_id FROM t) OR txn_id IN (SELECT org_txn_id FROM t))
  GROUP BY txn_id
),
o AS (
  SELECT txn_id, max(lower(substring(umn, position('@' IN umn) + 1))) AS paytm_handle FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '2020-01-01' AND business_type = 'MANDATE' AND txn_id IN (SELECT org_txn_id FROM t)
  GROUP BY txn_id
)
SELECT t.dt, t.status, coalesce(po.bank, ps.bank, 'NA') AS bank, coalesce(o.paytm_handle, 'NA') AS paytm_handle, t.other_handle,
  CASE WHEN t.status = 'FAILURE' THEN t.code ELSE '' END AS code, COUNT(DISTINCT t.umn) AS n
FROM t LEFT JOIN p po ON po.txn_id = t.org_txn_id LEFT JOIN p ps ON ps.txn_id = t.txn_id LEFT JOIN o ON o.txn_id = t.org_txn_id
GROUP BY 1, 2, 3, 4, 5, 6

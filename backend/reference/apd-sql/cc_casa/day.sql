-- One day of CC vs CASA (payer account_type) attempts by outcome / error code (code = app code, ncode = NPCI code else app code),
-- Autopay (purpose 14 mandates, by stage incl. PAUSE) and P2M. {day} = YYYY-MM-DD
-- Autopay unit = the UPI Error Code Spikes Mandate tab (team SR definition): executions (COLLECT) are one attempt per
-- UMN + payer scope_cust_id + execution number per day, latest status; CREATE / REVOKE / PAUSE one per UMN per day (latest status; golden mandate unit, same as the Mandate / CC Autopay tabs, 29 Oct); payer handle 'paytm'
-- excluded; COLLECT without an execution number dropped. P2M: one per txn, unchanged.
WITH tp AS (
  SELECT txn_id,
         MAX(CASE WHEN account_type = 'CREDIT' THEN 'CC' WHEN account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' END) AS acct,
         MAX(scope_cust_id) AS cust,
         MAX(handle) AS payer_handle
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND participant_type = 'PAYER'
  GROUP BY txn_id
),
ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, app_resp_code, npci_resp_code, umn, type,
         TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) AS ex,
         CASE WHEN business_type = 'MANDATE' THEN 'AUTOPAY' ELSE 'P2M' END AS scope,
         CASE WHEN business_type <> 'MANDATE' OR business_type IS NULL THEN 'PAY'
              WHEN type = 'CREATE' THEN '1 CREATE'
              WHEN type = 'COLLECT' AND TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) = 1 THEN '2 1st EXEC'
              WHEN type = 'COLLECT' AND TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) > 1 THEN '3 Recurring EXEC'
              WHEN type = 'REVOKE' THEN '4 REVOKE'
              WHEN type = 'PAUSE' THEN '5 PAUSE' END AS stage
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND ((business_type = 'MANDATE' AND json_extract_scalar(extended_info, '$.purpose') = '14')
         OR ((business_type IS NULL OR business_type <> 'MANDATE') AND category = 'VPA2MERCHANT' AND type IN ('PAY', 'COLLECT')))
),
j AS (
  SELECT ti.*, tp.acct,
         CASE WHEN ti.scope = 'AUTOPAY' AND ti.type = 'COLLECT' AND ti.umn IS NOT NULL AND tp.cust IS NOT NULL AND ti.ex IS NOT NULL
              THEN ti.umn || '|' || tp.cust || '|' || CAST(ti.ex AS VARCHAR)
              WHEN ti.scope = 'AUTOPAY' AND ti.umn IS NOT NULL THEN ti.umn ELSE ti.txn_id END AS k
  FROM ti JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.stage IS NOT NULL AND tp.acct IS NOT NULL
    AND (ti.scope = 'P2M' OR (COALESCE(tp.payer_handle, '') <> 'paytm' AND ti.umn IS NOT NULL AND substring(ti.umn, position('@' IN ti.umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')))   -- autopay: Paytm UMNs only (golden mandate unit, 29 Oct)
),
u AS (   -- one attempt per key, latest status
  SELECT dt, scope, stage, acct, max_by(status, created_on) AS status,
         max_by(app_resp_code, created_on) AS app_resp_code, max_by(npci_resp_code, created_on) AS npci_resp_code
  FROM j GROUP BY dt, scope, stage, acct, k
)
SELECT dt, scope, stage, acct,
       CASE WHEN status = 'FAILURE' THEN COALESCE(app_resp_code, 'UNKNOWN') ELSE status END AS code,
       CASE WHEN status = 'FAILURE' THEN COALESCE(npci_resp_code, app_resp_code, 'UNKNOWN') ELSE status END AS ncode,
       COUNT(*) AS txns
FROM u
GROUP BY 1, 2, 3, 4, 5, 6

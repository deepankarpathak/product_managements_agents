-- One day of Autopay (purpose 14) FAILURES by payer account (CC / CASA), stage and code (NPCI code, else app code),
-- split by payer bank (bank_code of the PAYER participant) and by payee handle (handle of the PAYEE participant). {day} = YYYY-MM-DD
-- Same unit as sql/day.sql (UPI Error Code Spikes Mandate tab): executions one per UMN + payer scope_cust_id + execution number
-- per day, latest status; others one per UMN per day; payer handle 'paytm' excluded.
WITH tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN CASE WHEN account_type = 'CREDIT' THEN 'CC' WHEN account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' END END) AS acct,
         MAX(CASE WHEN participant_type = 'PAYER' THEN scope_cust_id END) AS cust,
         MAX(CASE WHEN participant_type = 'PAYER' THEN handle END) AS payer_handle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS payer_bank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN LOWER(handle) END) AS payee_handle
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
  GROUP BY txn_id
),
ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, COALESCE(npci_resp_code, app_resp_code, 'UNKNOWN') AS code, umn, type,
         TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) AS ex,
         CASE WHEN type = 'CREATE' THEN 'CREATE'
              WHEN type = 'COLLECT' AND TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) = 1 THEN 'EXEC1'
              WHEN type = 'COLLECT' AND TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) > 1 THEN 'EXECR'
              WHEN type = 'REVOKE' THEN 'REVOKE'
              WHEN type = 'PAUSE' THEN 'PAUSE' END AS stage
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND json_extract_scalar(extended_info, '$.purpose') = '14'
),
u AS (   -- one attempt per key, latest status
  SELECT ti.dt, ti.stage, tp.acct, max_by(ti.status, ti.created_on) AS status, max_by(ti.code, ti.created_on) AS code,
         max_by(tp.payer_bank, ti.created_on) AS payer_bank, max_by(tp.payee_handle, ti.created_on) AS payee_handle
  FROM ti JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.stage IS NOT NULL AND tp.acct IS NOT NULL AND COALESCE(tp.payer_handle, '') <> 'paytm'
    AND ti.umn IS NOT NULL AND substring(ti.umn, position('@' IN ti.umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')   -- Paytm UMNs only (golden mandate unit, 29 Oct)
  GROUP BY ti.dt, ti.stage, tp.acct,
           CASE WHEN ti.type = 'COLLECT' AND ti.umn IS NOT NULL AND tp.cust IS NOT NULL AND ti.ex IS NOT NULL
                THEN ti.umn || '|' || tp.cust || '|' || CAST(ti.ex AS VARCHAR)
                WHEN ti.umn IS NOT NULL THEN ti.umn ELSE ti.txn_id END
)
SELECT dt, stage, acct, code,
       CASE WHEN GROUPING(payer_bank) = 0 THEN 'BANK' ELSE 'HANDLE' END AS dim,
       COALESCE(CASE WHEN GROUPING(payer_bank) = 0 THEN payer_bank ELSE payee_handle END, 'NULL') AS k,
       COUNT(*) AS n
FROM u
WHERE status = 'FAILURE'
GROUP BY GROUPING SETS ((dt, stage, acct, code, payer_bank), (dt, stage, acct, code, payee_handle))

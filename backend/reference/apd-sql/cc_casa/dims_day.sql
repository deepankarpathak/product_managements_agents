-- One day of CC vs CASA Autopay (purpose 14) attempts and successes by stage, split by payer bank, initiation mode and payee MCC.
-- Same unit as sql/day.sql (team SR definition): executions = one attempt per UMN + payer scope_cust_id + execution number per day,
-- latest status; CREATE / REVOKE / PAUSE one per UMN per day (latest status; golden mandate unit, same as the Mandate / CC Autopay tabs, 29 Oct); payer handle 'paytm' excluded; COLLECT without an execution number dropped.
-- Mode = the row's own extended_info.initiationMode (executions mostly carry 11 / blank). MCC = payee leg mcc. {day} = YYYY-MM-DD
WITH tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' AND account_type = 'CREDIT' THEN 'CC'
                  WHEN participant_type = 'PAYER' AND account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' END) AS acct,
         MAX(CASE WHEN participant_type = 'PAYER' THEN scope_cust_id END) AS cust,
         MAX(CASE WHEN participant_type = 'PAYER' THEN handle END) AS payer_handle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS bank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS mcc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
  GROUP BY txn_id
),
ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, umn, type,
         TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER) AS ex,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.initiationMode'), ''), 'NA') AS mode,
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
j AS (
  SELECT ti.*, tp.acct, COALESCE(tp.bank, 'NA') AS bank, COALESCE(tp.mcc, 'NA') AS mcc,
         CASE WHEN ti.type = 'COLLECT' AND ti.umn IS NOT NULL AND tp.cust IS NOT NULL AND ti.ex IS NOT NULL
              THEN ti.umn || '|' || tp.cust || '|' || CAST(ti.ex AS VARCHAR)
              WHEN ti.scope = 'AUTOPAY' AND ti.umn IS NOT NULL THEN ti.umn ELSE ti.txn_id END AS k
  FROM ti JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.stage IS NOT NULL AND tp.acct IS NOT NULL AND COALESCE(tp.payer_handle, '') <> 'paytm'
    AND ti.umn IS NOT NULL AND substring(ti.umn, position('@' IN ti.umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')   -- Paytm UMNs only (golden mandate unit, 29 Oct)
),
u AS (   -- one attempt per key, latest status (bank / mode / mcc of the latest row)
  SELECT dt, stage, acct, max_by(status, created_on) AS status, max_by(bank, created_on) AS bank,
         max_by(mode, created_on) AS mode, max_by(mcc, created_on) AS mcc
  FROM j GROUP BY dt, stage, acct, k
)
SELECT dt, stage, acct,
       CASE WHEN GROUPING(bank) = 0 THEN 'BANK' WHEN GROUPING(mode) = 0 THEN 'MODE' ELSE 'MCC' END AS dim,
       COALESCE(CASE WHEN GROUPING(bank) = 0 THEN bank END, CASE WHEN GROUPING(mode) = 0 THEN mode END, mcc) AS k,
       COUNT(*) AS att, SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS suc
FROM u
GROUP BY GROUPING SETS ((dt, stage, acct, bank), (dt, stage, acct, mode), (dt, stage, acct, mcc))

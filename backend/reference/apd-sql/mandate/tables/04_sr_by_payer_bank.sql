-- Automatic Payments Dashboard · SR by payer (remitter) bank per day
-- Mandate stage '{stage}' (CREATE / EXEC1 / EXECR / REVOKE / PAUSE / UNPAUSE), Paytm-app UMNs (handle paytm / ptaxis / pthdfc / ptsbi / ptyes), latest status;
-- executions: one attempt per UMN || execution number per day (EXEC1 = execution no 1, EXECR = > 1), other stages one per UMN per day
-- (UPI Alpha golden mandate unit, Queries/Mandate Queries/mandate_queries.sql). Dates {start} .. {end} inclusive; purpose '{purpose}'.
-- Payer bank = payer leg bank_code. The dashboard keeps the top 40 banks by attempts since 1 Oct; the rest is Other.
-- Run on Trino (catalog hive): TRINO_CATALOG=hive python3 Queries/run_trino_query.py --file <this file>
WITH ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, umn,
         CASE WHEN type <> 'COLLECT' THEN type
              WHEN try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) = 1 THEN 'EXEC1' ELSE 'EXECR' END AS stage,
         CASE WHEN type = 'COLLECT' THEN umn || '|' || json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') ELSE umn END AS unit,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.purpose'), ''), 'NA') AS purpose,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.initiationMode'), ''), 'NA') AS mode,
         COALESCE(NULLIF(npci_resp_code, ''), NULLIF(app_resp_code, ''), status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type IN ('CREATE', 'COLLECT', 'REVOKE', 'PAUSE', 'UNPAUSE')
    AND (type <> 'COLLECT' OR try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) >= 1)
    AND substring(umn, position('@' IN umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS pbank,
         MAX(CASE WHEN participant_type = 'PAYER' THEN handle END) AS phandle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN NULLIF(resp_code, '') END) AS prc,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN bank_code END) AS ebank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN handle END) AS ehandle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN NULLIF(resp_code, '') END) AS erc,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS mcc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00' + INTERVAL '1' DAY
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
),
-- golden mandate unit: one attempt per unit per day, latest status
u AS (
  SELECT ti.dt,
         max_by(ti.purpose, ti.created_on) AS purpose, max_by(ti.mode, ti.created_on) AS mode,
         max_by(ti.status, ti.created_on) AS status, max_by(ti.code, ti.created_on) AS code,
         max_by(COALESCE(tp.pbank, 'NA'), ti.created_on) AS pbank, max_by(COALESCE(tp.phandle, 'NA'), ti.created_on) AS phandle,
         max_by(COALESCE(tp.ebank, 'NA'), ti.created_on) AS ebank, max_by(COALESCE(tp.ehandle, 'NA'), ti.created_on) AS ehandle,
         max_by(COALESCE(tp.mcc, 'NA'), ti.created_on) AS mcc,
         max_by(CASE WHEN tp.prc IS NOT NULL THEN 'PAYER' WHEN tp.erc IS NOT NULL THEN 'PAYEE' ELSE 'NPCI_PSP' END, ti.created_on) AS side
  FROM ti LEFT JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.umn IS NOT NULL AND ti.stage = '{stage}'
  GROUP BY ti.dt, ti.unit
)
SELECT dt, pbank AS payer_bank, COUNT(*) AS attempts, SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS successful,
       ROUND(100.0 * SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) / COUNT(*), 2) AS sr_pct
FROM u
WHERE purpose = '{purpose}'
GROUP BY dt, pbank
ORDER BY dt, attempts DESC

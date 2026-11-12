-- Automatic Payments Dashboard · What is driving one failure code (Spikes dashboard method)
-- Mandate stage '{stage}' (CREATE / EXEC1 / EXECR / REVOKE / PAUSE / UNPAUSE), Paytm-app UMNs (handle paytm / ptaxis / pthdfc / ptsbi / ptyes), latest status;
-- executions: one attempt per UMN || execution number per day (EXEC1 = execution no 1, EXECR = > 1), other stages one per UMN per day
-- (UPI Alpha golden mandate unit, Queries/Mandate Queries/mandate_queries.sql). Dates {start} .. {end} inclusive; purpose '{purpose}'.
-- Set the code in params (default UM3). Rate = failures of the code / that bank's or handle's own attempts; normal = median rate of the
-- 14 days before D-1; extra = (rate - normal) x attempts. Payer-side / PSP / NPCI codes: split by payer bank; beneficiary codes: payee handle
-- (+ payee handle x beneficiary bank deep dive). The dashboard keeps D-1 and the 14 days before.
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
),
params AS (SELECT 'UM3' AS code),
f AS (SELECT u.*, CASE WHEN u.status <> 'SUCCESS' AND u.code = (SELECT code FROM params) THEN 1 ELSE 0 END AS hit FROM u WHERE purpose = '{purpose}')
SELECT dt, 'PAYER_BANK' AS split, pbank AS k, SUM(hit) AS failures, COUNT(*) AS attempts, ROUND(100.0 * SUM(hit) / COUNT(*), 3) AS rate_pct FROM f GROUP BY dt, pbank HAVING SUM(hit) > 0
UNION ALL
SELECT dt, 'PAYER_HANDLE', phandle, SUM(hit), COUNT(*), ROUND(100.0 * SUM(hit) / COUNT(*), 3) FROM f GROUP BY dt, phandle HAVING SUM(hit) > 0
UNION ALL
SELECT dt, 'PAYEE_HANDLE', ehandle, SUM(hit), COUNT(*), ROUND(100.0 * SUM(hit) / COUNT(*), 3) FROM f GROUP BY dt, ehandle HAVING SUM(hit) > 0
UNION ALL
SELECT dt, 'HANDLE_X_BANK', ehandle || ' x ' || ebank, SUM(hit), COUNT(*), ROUND(100.0 * SUM(hit) / COUNT(*), 3) FROM f GROUP BY dt, ehandle, ebank HAVING SUM(hit) > 0
ORDER BY dt, split, failures DESC

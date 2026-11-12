-- Code watch (user, 29 Oct): failures with UM8-ZM, UM8-Z6, UO8 per day and mandate type, {start} .. {end} (exclusive end).
-- Golden mandate unit (same as the Mandate / CC Autopay tabs): Paytm UMNs (umn handle paytm / ptaxis / pthdfc / ptsbi / ptyes), every purpose;
-- one unit per UMN per day (COLLECT: per UMN + execution number, execution number >= 1), latest status; a unit fails with a code when its
-- latest attempt that day failed with it (code = npci_resp_code, else app_resp_code).
-- Types: CREATE, UPDATE, COLLECT (execution 1 and above), PAUSE, UNPAUSE, PAYER_REVOKE (REVOKE raised from the payer's app:
-- extended_info.payerDeviceId present; merchant-raised revokes have no payer device).
WITH ti AS (
  SELECT DATE(created_on) AS dt, created_on, status, umn,
         CASE WHEN type = 'REVOKE' THEN 'PAYER_REVOKE' ELSE type END AS stage,
         CASE WHEN type = 'COLLECT' THEN umn || '|' || json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') ELSE umn END AS unit,
         COALESCE(NULLIF(npci_resp_code, ''), NULLIF(app_resp_code, ''), status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00'
    AND business_type = 'MANDATE' AND type IN ('CREATE', 'UPDATE', 'COLLECT', 'PAUSE', 'UNPAUSE', 'REVOKE')
    AND (type <> 'COLLECT' OR try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) >= 1)
    AND (type <> 'REVOKE' OR json_extract_scalar(extended_info, '$.payerDeviceId') IS NOT NULL)
    AND umn IS NOT NULL AND substring(umn, position('@' IN umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
u AS (
  SELECT dt, stage, max_by(status, created_on) AS status, max_by(code, created_on) AS code
  FROM ti GROUP BY dt, stage, unit
)
SELECT dt, stage, CASE WHEN status <> 'SUCCESS' AND code IN ('UM8-ZM', 'UM8-Z6', 'UO8') THEN code ELSE 'ALL' END AS code,
       COUNT(*) AS att, SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS suc
FROM u GROUP BY 1, 2, 3

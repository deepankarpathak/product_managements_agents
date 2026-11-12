-- Mandate failures for one day, every stage (same stages and units as mandate_day.sql): who is behind each failure code. {day} = YYYY-MM-DD
-- Same unit as mandate_day.sql (Paytm-app UMNs, one per UMN per day, latest status); only units that did not succeed.
-- side: PAYER when the payer leg carries a response code (remitter bank, e.g. UM8-ZM), PAYEE when the payee leg does (e.g. UM1-UP),
-- else NPCI_PSP (e.g. UM3, U16, ZA). Split by payer bank / payer handle (Paytm PSP handle) / payee bank / payee handle, and payee handle x
-- beneficiary bank (HANDLE_X_BANK, k = handle|bank: the Spikes dashboard deep dive). purpose / mode 'ALL' = all.
WITH ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, umn,
         CASE WHEN type <> 'COLLECT' THEN type
              WHEN try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) = 1 THEN 'EXEC1' ELSE 'EXECR' END AS stage,
         CASE WHEN type = 'COLLECT' THEN umn || '|' || json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') ELSE umn END AS unit,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.purpose'), ''), 'NA') AS purpose,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.initiationMode'), ''), 'NA') AS mode,
         COALESCE(NULLIF(npci_resp_code, ''), NULLIF(app_resp_code, ''), status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type IN ('CREATE', 'COLLECT', 'REVOKE', 'PAUSE', 'UNPAUSE')
    AND (type <> 'COLLECT' OR try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) >= 1)
    AND substring(umn, position('@' IN umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS pbank, MAX(CASE WHEN participant_type = 'PAYER' THEN lower(handle) END) AS phandle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN NULLIF(resp_code, '') END) AS prc,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN bank_code END) AS ebank, MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(handle) END) AS ehandle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN NULLIF(resp_code, '') END) AS erc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
),
u AS (
  SELECT ti.dt, ti.stage, max_by(ti.purpose, ti.created_on) AS purpose, max_by(ti.mode, ti.created_on) AS mode, max_by(ti.status, ti.created_on) AS status,
         max_by(ti.code, ti.created_on) AS code,
         max_by(CASE WHEN tp.prc IS NOT NULL THEN 'PAYER' WHEN tp.erc IS NOT NULL THEN 'PAYEE' ELSE 'NPCI_PSP' END, ti.created_on) AS side,
         max_by(COALESCE(tp.pbank, 'NA'), ti.created_on) AS pbank, max_by(COALESCE(tp.phandle, 'NA'), ti.created_on) AS phandle,
         max_by(COALESCE(tp.ebank, 'NA'), ti.created_on) AS ebank, max_by(COALESCE(tp.ehandle, 'NA'), ti.created_on) AS ehandle
  FROM ti LEFT JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.umn IS NOT NULL
  GROUP BY ti.dt, ti.stage, ti.unit
),
m AS (
  SELECT dt, stage, p.purpose, md.mode, code, side, pbank, phandle, ebank, ehandle, ehandle || '|' || ebank AS hxb
  FROM u CROSS JOIN UNNEST(ARRAY[u.purpose, 'ALL']) AS p(purpose) CROSS JOIN UNNEST(ARRAY[u.mode, 'ALL']) AS md(mode)
  WHERE u.status <> 'SUCCESS'
)
SELECT dt, stage, purpose, mode, code,
       CASE WHEN GROUPING(side) = 0 THEN 'SIDE' WHEN GROUPING(pbank) = 0 THEN 'PAYER_BANK' WHEN GROUPING(phandle) = 0 THEN 'PAYER_HANDLE'
            WHEN GROUPING(ebank) = 0 THEN 'PAYEE_BANK' WHEN GROUPING(ehandle) = 0 THEN 'PAYEE_HANDLE' ELSE 'HANDLE_X_BANK' END AS dim,
       COALESCE(CASE WHEN GROUPING(side) = 0 THEN side END, CASE WHEN GROUPING(pbank) = 0 THEN pbank END,
                CASE WHEN GROUPING(phandle) = 0 THEN phandle END, CASE WHEN GROUPING(ebank) = 0 THEN ebank END,
                CASE WHEN GROUPING(ehandle) = 0 THEN ehandle END, hxb) AS k,
       COUNT(*) AS n
FROM m
GROUP BY GROUPING SETS ((dt, stage, purpose, mode, code, side), (dt, stage, purpose, mode, code, pbank), (dt, stage, purpose, mode, code, phandle),
                        (dt, stage, purpose, mode, code, ebank), (dt, stage, purpose, mode, code, ehandle), (dt, stage, purpose, mode, code, hxb))

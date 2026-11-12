-- Mandate CREATE for one day, by purpose x initiation mode x {payer bank, payer handle, payee bank, payee handle, payee MCC, failure code}. {day} = YYYY-MM-DD
-- purpose / mode 'ALL' rows = every purpose / every mode.
-- Golden mandate unit (UPI Alpha Queries/Mandate Queries/mandate_queries.sql): Paytm-app UMNs (umn handle in paytm/ptaxis/pthdfc/ptsbi/ptyes),
-- one attempt per UMN per day, latest status (MAX_BY created_on). Mode = extended_info.initiationMode (00 collect, 04 intent, 13 QR); mode 'ALL' = every mode.
-- Code = npci_resp_code of the latest row, else app_resp_code (Paytm-side INT declines), else status; successes carry code 'SUCCESS'.
WITH ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, umn,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.purpose'), ''), 'NA') AS purpose,
         COALESCE(NULLIF(json_extract_scalar(extended_info, '$.initiationMode'), ''), 'NA') AS mode,
         COALESCE(NULLIF(npci_resp_code, ''), NULLIF(app_resp_code, ''), status) AS code
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type = 'CREATE'
    AND substring(umn, position('@' IN umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS pbank,
         MAX(CASE WHEN participant_type = 'PAYER' THEN lower(handle) END) AS phandle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(handle) END) AS ehandle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN bank_code END) AS ebank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS mcc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
),
u AS (
  SELECT ti.dt, max_by(ti.purpose, ti.created_on) AS purpose, max_by(ti.status, ti.created_on) AS status, max_by(ti.mode, ti.created_on) AS mode,
         max_by(COALESCE(tp.pbank, 'NA'), ti.created_on) AS pbank, max_by(COALESCE(tp.ebank, 'NA'), ti.created_on) AS ebank,
         max_by(COALESCE(tp.mcc, 'NA'), ti.created_on) AS mcc,
         max_by(COALESCE(tp.phandle, 'NA'), ti.created_on) AS phandle, max_by(COALESCE(tp.ehandle, 'NA'), ti.created_on) AS ehandle, max_by(ti.code, ti.created_on) AS code
  FROM ti LEFT JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.umn IS NOT NULL
  GROUP BY ti.dt, ti.umn
),
m AS (
  SELECT dt, p.purpose, md.mode, status, pbank, ebank, mcc, phandle, ehandle, CASE WHEN status = 'SUCCESS' THEN 'SUCCESS' ELSE code END AS code
  FROM u CROSS JOIN UNNEST(ARRAY[u.purpose, 'ALL']) AS p(purpose) CROSS JOIN UNNEST(ARRAY[u.mode, 'ALL']) AS md(mode)
)
SELECT dt, purpose, mode,
       CASE WHEN GROUPING(pbank) = 0 THEN 'PAYER_BANK' WHEN GROUPING(ebank) = 0 THEN 'PAYEE_BANK' WHEN GROUPING(mcc) = 0 THEN 'MCC'
            WHEN GROUPING(code) = 0 THEN 'CODE' WHEN GROUPING(phandle) = 0 THEN 'PAYER_HANDLE' WHEN GROUPING(ehandle) = 0 THEN 'PAYEE_HANDLE' ELSE 'TOTAL' END AS dim,
       COALESCE(CASE WHEN GROUPING(pbank) = 0 THEN pbank END, CASE WHEN GROUPING(ebank) = 0 THEN ebank END,
                CASE WHEN GROUPING(mcc) = 0 THEN mcc END, CASE WHEN GROUPING(code) = 0 THEN code END,
                CASE WHEN GROUPING(phandle) = 0 THEN phandle END, CASE WHEN GROUPING(ehandle) = 0 THEN ehandle END, 'ALL') AS k,
       COUNT(*) AS att, SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS suc
FROM m
GROUP BY GROUPING SETS ((dt, purpose, mode), (dt, purpose, mode, pbank), (dt, purpose, mode, ebank), (dt, purpose, mode, mcc), (dt, purpose, mode, code),
                        (dt, purpose, mode, phandle), (dt, purpose, mode, ehandle))

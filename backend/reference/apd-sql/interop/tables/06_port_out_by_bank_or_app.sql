-- Automatic Payments Dashboard · Interop · Port-Out · mandates leaving Paytm (by bank / by app it went to)
-- Purpose BC UPDATE on switch.txn_info where the new UMN sits on another app's handle (mandate moves from Paytm to that app).
-- Count = distinct new UMNs per day and status. payer_bank = bank_code of the original Paytm mandate (org_txn_id); app = handle of the new UMN.
-- Slow (~6 min): the org_txn_id lookup scans participants from 2020.
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
),
b2 AS (
  SELECT dt, status, umn, payer_bank,
        CASE
            WHEN regexp_like(other_handle, '^(okhdfcbank|okaxis|oksbi|okicici)$') THEN 'Google Pay'
            WHEN regexp_like(other_handle, '^(ybl|axl|ibl)$') THEN 'PhonePe'
            WHEN regexp_like(other_handle, '^abfspay$') THEN 'Bajaj Finserv'
            WHEN regexp_like(other_handle, '^barodampay$') THEN 'BHIM Baroda Pay'
            WHEN regexp_like(other_handle, '^idbi$') THEN 'BHIM PayWiz / IDBI GO Mobile+'
            WHEN regexp_like(other_handle, '^upi$') THEN 'BHIM'
            WHEN regexp_like(other_handle, '^aubank$') THEN 'BHIM AUPay'
            WHEN regexp_like(other_handle, '^bandhan$') THEN 'BHIM Bandhan UPI'
            WHEN regexp_like(other_handle, '^dlb$') THEN 'BHIM DLB UPI / DhanSmart'
            WHEN regexp_like(other_handle, '^indus$') THEN 'BHIM IndusPay'
            WHEN regexp_like(other_handle, '^kbl$') THEN 'BHIM KBL'
            WHEN regexp_like(other_handle, '^federal$') THEN 'BHIM Lotza UPI'
            WHEN regexp_like(other_handle, '^pnb$') THEN 'BHIM PNB'
            WHEN regexp_like(other_handle, '^sbi$') THEN 'BHIM SBIPay'
            WHEN regexp_like(other_handle, '^uco$') THEN 'BHIM UCO UPI'
            WHEN regexp_like(other_handle, '^dbs$') THEN 'DigiBank DBS'
            WHEN regexp_like(other_handle, '^freecharge$') THEN 'Freecharge'
            WHEN regexp_like(other_handle, '^yesg$') THEN 'Groww Pay'
            WHEN regexp_like(other_handle, '^hsbc$') THEN 'HSBC Simply Pay'
            WHEN regexp_like(other_handle, '^icici$') THEN 'iMobile ICICI'
            WHEN regexp_like(other_handle, '^indie$') THEN 'Indie'
            WHEN regexp_like(other_handle, '^inhdfc$') THEN 'INDmoney'
            WHEN regexp_like(other_handle, '^(indianbank|allbank)$') THEN 'IndOASIS'
            WHEN regexp_like(other_handle, '^kotak$') THEN 'Kotak'
            WHEN regexp_like(other_handle, '^ikwik$') THEN 'MobiKwik'
            WHEN regexp_like(other_handle, '^naviaxis$') THEN 'Navi'
            WHEN regexp_like(other_handle, '^(unionbankofindia|uboi|unionbank)$') THEN 'Union Ease'
            WHEN regexp_like(other_handle, '^(ptaxis|pthdfc|ptyes|ptsbi|paytm)$') THEN 'Paytm'
            WHEN regexp_like(other_handle, '^pz$') THEN 'PayZapp'
            WHEN regexp_like(other_handle, '^shriramhdfcbank$') THEN 'Shriram One'
            WHEN regexp_like(other_handle, '^sib$') THEN 'SIB Mirror+'
            WHEN regexp_like(other_handle, '^yespay$') THEN 'YES Pay Next'
            WHEN regexp_like(other_handle, '^tmb$') THEN 'TMB MBank'
            ELSE 'Others'
        END AS app_it_went_to
  FROM base
)
SELECT dt, payer_bank, app_it_went_to,
       COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) AS success,
       COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END) AS failure,
       ROUND(100.0 * COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END)
             / NULLIF(COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) + COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END), 0), 2) AS sr_pct
FROM b2
GROUP BY GROUPING SETS ((dt), (dt, payer_bank), (dt, app_it_went_to))   -- both NULL = all port-outs; 'By bank' rows have payer_bank, 'By app' rows app_it_went_to
ORDER BY dt, success DESC, failure DESC

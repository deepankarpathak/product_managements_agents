-- Automatic Payments Dashboard · Interop · Purpose BC · Port-In (one panel: summary by BC type, source app, Paytm handle, payer bank)
-- Purpose BC on upi_activities = two different things:
--   type IN_PORT        = Port-In: a mandate created on another app moves to a Paytm handle (new UMN on @paytm/@ptyes/@ptaxis/@pthdfc/@ptsbi, prevumn = old UMN)
--   any other type      = UPDATE (almost all failures), OUT_PORT, blank — NOT port-ins; Superset 4621 "PURPOSE_BC_SUCCESS" counts them too
-- Count = distinct UMNs per day and status; SR = success / (success + failure). Source app = handle of prevumn (Superset dataset 7408 mapping).
-- Dates {start} .. {end} both included (the dashboard fills in the chosen days; for the 'Till date' column use start 2025-12-23).
-- Run on Trino (catalog hive): TRINO_CATALOG=hive python3 ~/trino/run_trino_query.py --file <this file>
WITH bc AS (
  SELECT DATE(dl_last_updated) AS dt, status, umn, type, prevumn, payer_bank_name
  FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{end}' + INTERVAL '1' DAY
    AND businesstype = 'MANDATE' AND status IN ('SUCCESS', 'FAILURE') AND purpose_code = 'BC'
),
port_in AS (
  SELECT dt, status, umn, payer_bank_name AS payer_bank,
    COALESCE(REGEXP_EXTRACT(LOWER(umn), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$', 1), 'OTHER') AS paytm_handle,
        CASE
          WHEN regexp_like(lower(prevumn), '@(okhdfcbank|okaxis|oksbi|okicici)$') THEN 'Google Pay'
          WHEN regexp_like(lower(prevumn), '@(ybl|axl|ibl)$') THEN 'PhonePe'
          WHEN regexp_like(lower(prevumn), '@abfspay$') THEN 'Bajaj Finserv'
          WHEN regexp_like(lower(prevumn), '@barodampay$') THEN 'BHIM Baroda Pay'
          WHEN regexp_like(lower(prevumn), '@idbi$') THEN 'BHIM PayWiz / IDBI GO Mobile+'
          WHEN regexp_like(lower(prevumn), '@upi$') THEN 'BHIM'
          WHEN regexp_like(lower(prevumn), '@aubank$') THEN 'BHIM AUPay'
          WHEN regexp_like(lower(prevumn), '@bandhan$') THEN 'BHIM Bandhan UPI'
          WHEN regexp_like(lower(prevumn), '@dlb$') THEN 'BHIM DLB UPI / DhanSmart'
          WHEN regexp_like(lower(prevumn), '@indus$') THEN 'BHIM IndusPay'
          WHEN regexp_like(lower(prevumn), '@kbl$') THEN 'BHIM KBL'
          WHEN regexp_like(lower(prevumn), '@federal$') THEN 'BHIM Lotza UPI'
          WHEN regexp_like(lower(prevumn), '@pnb$') THEN 'BHIM PNB'
          WHEN regexp_like(lower(prevumn), '@sbi$') THEN 'BHIM SBIPay'
          WHEN regexp_like(lower(prevumn), '@uco$') THEN 'BHIM UCO UPI'
          WHEN regexp_like(lower(prevumn), '@dbs$') THEN 'DigiBank DBS'
          WHEN regexp_like(lower(prevumn), '@freecharge$') THEN 'Freecharge'
          WHEN regexp_like(lower(prevumn), '@yesg$') THEN 'Groww Pay'
          WHEN regexp_like(lower(prevumn), '@hsbc$') THEN 'HSBC Simply Pay'
          WHEN regexp_like(lower(prevumn), '@icici$') THEN 'iMobile ICICI'
          WHEN regexp_like(lower(prevumn), '@indie$') THEN 'Indie'
          WHEN regexp_like(lower(prevumn), '@inhdfc$') THEN 'INDmoney'
          WHEN regexp_like(lower(prevumn), '@(indianbank|allbank)$') THEN 'IndOASIS'
          WHEN regexp_like(lower(prevumn), '@kotak$') THEN 'Kotak'
          WHEN regexp_like(lower(prevumn), '@ikwik$') THEN 'MobiKwik'
          WHEN regexp_like(lower(prevumn), '@naviaxis$') THEN 'Navi'
          WHEN regexp_like(lower(prevumn), '@(unionbankofindia|uboi|unionbank)$') THEN 'Union Ease'
          WHEN regexp_like(lower(prevumn), '@(ptaxis|pthdfc|ptyes|ptsbi|paytm)$') THEN 'Paytm'
          WHEN regexp_like(lower(prevumn), '@pz$') THEN 'PayZapp'
          WHEN regexp_like(lower(prevumn), '@shriramhdfcbank$') THEN 'Shriram One'
          WHEN regexp_like(lower(prevumn), '@sib$') THEN 'SIB Mirror+'
          WHEN regexp_like(lower(prevumn), '@yespay$') THEN 'YES Pay Next'
          WHEN regexp_like(lower(prevumn), '@tmb$') THEN 'TMB MBank'
          ELSE 'Others'
      END AS source_app
  FROM bc
  WHERE type = 'IN_PORT'
)
-- 1 Summary: every purpose BC row by type (Port-In vs the rest)
SELECT dt, '1 BC type' AS split,
  CASE WHEN type = 'IN_PORT' THEN 'Port-In (IN_PORT)' ELSE 'Other BC (' || COALESCE(type, 'blank') || ')' END AS name,
  COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) AS success,
  COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END) AS failure,
  ROUND(100.0 * COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END)
        / NULLIF(COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) + COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END), 0), 2) AS sr_pct
FROM bc GROUP BY 1, 2, 3
UNION ALL
-- 2-4 Port-In only: where it came from, which Paytm handle it landed on, payer bank
SELECT dt,
  CASE WHEN GROUPING(source_app) = 0 THEN '2 Source app' WHEN GROUPING(paytm_handle) = 0 THEN '3 Paytm handle' ELSE '4 Payer bank' END AS split,
  COALESCE(source_app, paytm_handle, payer_bank) AS name,
  COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) AS success,
  COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END) AS failure,
  ROUND(100.0 * COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END)
        / NULLIF(COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) + COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END), 0), 2) AS sr_pct
FROM port_in
GROUP BY GROUPING SETS ((dt, source_app), (dt, paytm_handle), (dt, payer_bank))
ORDER BY split, dt, success DESC

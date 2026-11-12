-- Interop panel (Automatic Payments Dashboard), days {start} (incl.) to {end} (excl.).
-- Source: the user's Superset Interop dashboards 2070 + 3023 (datasets 4598 4620 4621 7408 7608 7610-7615 7619), all on
-- upi_txn.upi_activities_data_snapshot_v3, businesstype MANDATE, dated by DATE(dl_last_updated). Their rules, kept as is:
--   cls  UPDATE_VPA = type UPDATE and txn_id LIKE 'VPA%' · UPDATEMIC = type UPDATEMIC · IN_PORT = type IN_PORT · OTHER (only kept for purpose BC: dataset 4621 counts every BC type)
--   payer handle (payer_vpa) and UMN handle: paytm / ptyes / ptaxis / pthdfc / ptsbi, else OTHER · source app from prevumn (dataset 7408 mapping)
-- One grouping set per split; n = COUNT(DISTINCT umn) as in the dashboards, rows = COUNT(*) (dataset 7408 counts rows).
WITH base AS (
  SELECT
    DATE(dl_last_updated) AS dt, status, purpose_code AS purpose, umn, payer_bank_name,
    CASE WHEN type = 'UPDATE' AND txn_id LIKE 'VPA%' THEN 'UPDATE_VPA' WHEN type = 'UPDATEMIC' THEN 'UPDATEMIC' WHEN type = 'IN_PORT' THEN 'IN_PORT' ELSE 'OTHER' END AS cls,
    COALESCE(REGEXP_EXTRACT(LOWER(payer_vpa), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$', 1), 'OTHER') AS payer_h,
    COALESCE(REGEXP_EXTRACT(LOWER(umn), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$', 1), 'OTHER') AS umn_h,
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
    END AS app
  FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{end}'
    AND businesstype = 'MANDATE' AND status IN ('SUCCESS', 'FAILURE')
    AND (type IN ('UPDATEMIC', 'IN_PORT') OR (type = 'UPDATE' AND txn_id LIKE 'VPA%') OR purpose_code = 'BC')
)
SELECT dt, status, cls, COALESCE(purpose, 'NA') AS purpose,
  CASE WHEN GROUPING(payer_bank_name) = 0 THEN 'BANK' WHEN GROUPING(payer_h) = 0 THEN 'PAYER_H' WHEN GROUPING(umn_h) = 0 THEN 'UMN_H' WHEN GROUPING(app) = 0 THEN 'APP' ELSE 'TOTAL' END AS dim,
  COALESCE(payer_bank_name, payer_h, umn_h, app, '') AS k,
  COUNT(DISTINCT umn) AS n, COUNT(*) AS rows_
FROM base
GROUP BY GROUPING SETS ((dt, status, cls, purpose), (dt, status, cls, purpose, payer_bank_name), (dt, status, cls, purpose, payer_h), (dt, status, cls, purpose, umn_h), (dt, status, cls, purpose, app))

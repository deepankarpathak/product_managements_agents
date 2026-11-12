-- PARKED (not run): merchant (payee name) split for mandate CREATE from LIVE switchv2 (TPAP Redash data source 1, MySQL).
-- Payee names are NULL in every Trino table; live txn_participants keeps only ~7 days. Run per one-hour updated_on slice
-- ({a} .. {z}) for created day {day} .. {d1}; {d0} = day 00:00 minus 1 hour. ~6 s per slice when tested on 28 Oct 2026.
SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ti.extended_info, '$.initiationMode')), ''), 'NA') AS mode, tp.name,
  COUNT(DISTINCT ti.umn) AS att, COUNT(DISTINCT CASE WHEN ti.status = 'SUCCESS' THEN ti.umn END) AS suc
FROM txn_info ti FORCE INDEX (idx_txn_info_business_type_updated_on)
STRAIGHT_JOIN txn_participants tp FORCE INDEX (idx_txn_participants_txnid_system_time)
  ON tp.txn_id = ti.txn_id AND tp.participant_type = 'PAYEE' AND tp.system_timestamp >= '{d0}'
WHERE ti.business_type = 'MANDATE' AND ti.updated_on >= '{a}' AND ti.updated_on < '{z}'
  AND ti.created_on >= '{day}' AND ti.created_on < '{d1}' AND ti.type = 'CREATE'
  AND JSON_UNQUOTE(JSON_EXTRACT(ti.extended_info, '$.purpose')) = '14'
  AND SUBSTRING_INDEX(ti.umn, '@', -1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
GROUP BY 1, 2

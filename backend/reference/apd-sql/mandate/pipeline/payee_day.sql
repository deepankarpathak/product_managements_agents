-- Automatic Payments Dashboard · Top merchants (payees) by successful mandate creations, one day {day}
-- The user's query (30 Oct 2026): business_type MANDATE, type CREATE, status SUCCESS, purpose LIKE '%14%', payee leg vpa + name, COUNT(DISTINCT umn).
-- Every UMN on the switch (the user's query has no UMN-handle filter). cc = 1 when any participant has account_type CREDIT (CC Autopay tab, pull.py cc()).
-- One row per payee vpa x cc flag; the page sums days into D-1 / D-2 / D-3 / Last 7 days / MTD / LMTD.
WITH ti AS (
  SELECT txn_id, umn
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type = 'CREATE' AND status = 'SUCCESS'
    AND json_extract_scalar(extended_info, '$.purpose') LIKE '%14%'
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(vpa) END) AS vpa,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN name END) AS name,
         MAX(CASE WHEN account_type = 'CREDIT' THEN 1 ELSE 0 END) AS cc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{day}'
    AND created_on >= TIMESTAMP '{day} 00:00:00' AND created_on < TIMESTAMP '{day} 00:00:00' + INTERVAL '1' DAY
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
)
SELECT DATE '{day}' AS dt, tp.cc, COALESCE(tp.vpa, 'NULL') AS vpa, MAX(tp.name) AS name, COUNT(DISTINCT ti.umn) AS n
FROM ti JOIN tp ON ti.txn_id = tp.txn_id
GROUP BY 2, 3

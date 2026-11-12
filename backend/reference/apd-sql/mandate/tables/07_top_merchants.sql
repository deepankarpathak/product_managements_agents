-- Automatic Payments Dashboard · Top 20 merchants (payees) by successful mandate creations
-- The user's query (30 Oct 2026) on Trino: business_type MANDATE, type CREATE, status SUCCESS, purpose LIKE '%14%', payee leg vpa + name,
-- COUNT(DISTINCT umn) per window. Every UMN on the switch (no UMN-handle filter, as in the user's query). D-1 = {end}.
-- Windows: D-1, D-2, D-3 (single days), Last 7 days (D-7 .. D-1), MTD (1st of the month .. D-1), LMTD (1st of last month .. same day last month).
-- Run on Trino (catalog hive): TRINO_CATALOG=hive python3 Queries/run_trino_query.py --file <this file>
WITH ti AS (
  SELECT txn_id, umn, DATE(created_on) AS dt
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00' + INTERVAL '1' DAY
    AND business_type = 'MANDATE' AND type = 'CREATE' AND status = 'SUCCESS'
    AND json_extract_scalar(extended_info, '$.purpose') LIKE '%14%'
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(vpa) END) AS payee_vpa,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN name END) AS payee_name
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}'
    AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00' + INTERVAL '1' DAY
  GROUP BY txn_id
),
x AS (SELECT ti.dt, ti.umn, tp.payee_vpa, tp.payee_name FROM ti LEFT JOIN tp ON ti.txn_id = tp.txn_id)
SELECT payee_name, payee_vpa,
       COUNT(DISTINCT CASE WHEN dt = DATE '{end}' THEN umn END) AS d_1,
       COUNT(DISTINCT CASE WHEN dt = DATE '{end}' - INTERVAL '1' DAY THEN umn END) AS d_2,
       COUNT(DISTINCT CASE WHEN dt = DATE '{end}' - INTERVAL '2' DAY THEN umn END) AS d_3,
       COUNT(DISTINCT CASE WHEN dt >= DATE '{end}' - INTERVAL '6' DAY THEN umn END) AS last_7_days,
       COUNT(DISTINCT CASE WHEN dt >= date_trunc('month', DATE '{end}') THEN umn END) AS mtd,
       COUNT(DISTINCT CASE WHEN dt < date_trunc('month', DATE '{end}') AND dt <= DATE '{end}' - INTERVAL '1' MONTH THEN umn END) AS lmtd
FROM x
GROUP BY 1, 2
ORDER BY d_1 DESC
LIMIT 20

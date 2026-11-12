-- Automatic Payments Dashboard · Interop · Update MIC · bank-wise
-- Superset charts updatemic_interop_report / update_mic_bank_wise_failure (datasets 4620, 7619) by payer bank: type UPDATEMIC.
-- Count = distinct UMNs per day and status; SR = success / (success + failure).
-- Dates {start} .. {end} both included (the dashboard fills in the chosen days; for the 'Till date' column use start 2025-12-23).
-- Run on Trino (catalog hive): TRINO_CATALOG=hive python3 ~/trino/run_trino_query.py --file <this file>
WITH base AS (
  SELECT DATE(dl_last_updated) AS dt, status, umn, payer_bank_name AS payer_bank
  FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{end}' + INTERVAL '1' DAY
    AND businesstype = 'MANDATE' AND status IN ('SUCCESS', 'FAILURE')
    AND type = 'UPDATEMIC'
)
SELECT dt, payer_bank,
       COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) AS success,
       COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END) AS failure,
       ROUND(100.0 * COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END)
             / NULLIF(COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN umn END) + COUNT(DISTINCT CASE WHEN status = 'FAILURE' THEN umn END), 0), 2) AS sr_pct
FROM base
GROUP BY GROUPING SETS ((dt), (dt, payer_bank))   -- payer_bank NULL = all banks
ORDER BY dt, success DESC, failure DESC

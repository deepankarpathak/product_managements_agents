-- Interop panel: unique UMNs per month, for the "Overall - Success Count" chart (Superset dataset 7608, dashboard 3023),
-- plus failures and the Paytm-handle (TPAP) view of datasets 7610 / 7611. Months {start} (incl.) to {end} (excl.).
-- metric: Update VPA = type UPDATE and txn_id LIKE 'VPA%' · Update MIC = type UPDATEMIC · Port-In = purpose BC and type IN_PORT
-- tpap: 1 when the payer_vpa (Update VPA / MIC) or the UMN (Port-In) is on paytm / ptyes / ptaxis / pthdfc / ptsbi, as in 7610 / 7611.
WITH base AS (
  SELECT DATE_TRUNC('month', DATE(dl_last_updated)) AS month, status, umn,
    CASE WHEN type = 'UPDATE' AND txn_id LIKE 'VPA%' THEN 'Update VPA' WHEN type = 'UPDATEMIC' THEN 'Update MIC'
         WHEN purpose_code = 'BC' AND type = 'IN_PORT' THEN 'Port-In' END AS metric,
    CASE WHEN purpose_code = 'BC' AND type = 'IN_PORT' THEN REGEXP_LIKE(LOWER(umn), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$')
         ELSE REGEXP_LIKE(LOWER(payer_vpa), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$') END AS tpap
  FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{end}'
    AND businesstype = 'MANDATE' AND status IN ('SUCCESS', 'FAILURE')
)
SELECT month, status, metric, 'ALL' AS scope, COUNT(DISTINCT umn) AS n FROM base WHERE metric IS NOT NULL GROUP BY 1, 2, 3
UNION ALL
SELECT month, status, metric, 'TPAP' AS scope, COUNT(DISTINCT umn) AS n FROM base WHERE metric IS NOT NULL AND tpap GROUP BY 1, 2, 3

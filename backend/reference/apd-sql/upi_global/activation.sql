-- UPI Global (International) service activation, {S} .. {E} by updated_on: day x payer PSP (user psp_id) x bank IFSC prefix.
-- Combines the user's q1 (by day x PSP, join user_snapshot_v3 for psp_id) and q2 (by day x bank) in one pull; the page does top-N / totals.
SELECT date(a.updated_on) d, u.psp_id, coalesce(a.account_provider_ifsc, 'NULL') bank, count(*) attempts, count_if(a.status = 'ACTIVE') activated
FROM hive.tpap_pms.account_activation_snapshot_v3 a
JOIN hive.tpap_pms.user_snapshot_v3 u ON u.id = CAST(a.user_id AS bigint) AND u.dl_last_updated <= CURRENT_DATE
WHERE a.dl_last_updated >= DATE '{S}' AND a.service_name = 'INTERNATIONAL'
  AND a.updated_on >= TIMESTAMP '{S} 00:00:00' AND a.updated_on < TIMESTAMP '{E1} 00:00:00'
GROUP BY 1, 2, 3

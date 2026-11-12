-- Interop panel · Port-In / Port-Out analysis (Automatic Payments Dashboard). Ports made {start} (incl.) to {end} (excl.); lifecycle looked up to {asof} (excl.).
-- One row per ported mandate.
--   IN  = successful Port-In to Paytm: upi_txn.upi_activities_data_snapshot_v3 type IN_PORT, purpose BC, status SUCCESS (as Superset 7408 / 7614).
--         umn = new Paytm UMN, other_umn = prevumn (the UMN at the app it came from). internal = 1 when prevumn is already on a Paytm handle (handle move, not a real port).
--   OUT = successful Port-Out from Paytm: switch.txn_info_snapshot_v3 type UPDATE, purpose BC (extended_info), status SUCCESS, UMN on another app's handle;
--         org_txn_id = the original Paytm mandate's txn_id -> its UMN (umn), other_umn = the new UMN at the other app.
-- Executions = switch.txn_info_snapshot_v3 type COLLECT on the Paytm UMN: IN after the port, OUT before the port (the business that left).
--   exec_suc / exec_fail = successful / failed execution txns, gmv = sum of amount of successful ones.
-- state = latest successful REVOKE / PAUSE / UNPAUSE on the Paytm UMN (IN: after the port; OUT: before it): REVOKED / PAUSED / ACTIVE (none, or UNPAUSE last).
-- again: worked out again in port_pull.py build() on the UMN id (part before '@', kept across ports); the columns below are a first pass on the full UMN.
--        OUT -> 'BACK' when the new UMN later ported back in to Paytm (a later IN_PORT's prevumn).
WITH pin AS (
  SELECT umn, max(prevumn) AS other_umn, min(DATE(dl_last_updated)) AS port_dt, max(payeename) AS payee, max(payee_vpa) AS payee_vpa
  FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{end}'
    AND businesstype = 'MANDATE' AND purpose_code = 'BC' AND type = 'IN_PORT' AND status = 'SUCCESS'
  GROUP BY umn
),
pout0 AS (
  SELECT umn AS other_umn, org_txn_id, min(DATE(created_on)) AS port_dt
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND created_on >= TIMESTAMP '{start} 00:00:00' AND created_on < TIMESTAMP '{end} 00:00:00'
    AND business_type = 'MANDATE' AND type = 'UPDATE' AND json_extract_scalar(extended_info, '$.purpose') = 'BC' AND status = 'SUCCESS'
    AND substring(umn, position('@' IN umn) + 1) NOT IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
  GROUP BY umn, org_txn_id
),
org AS (
  SELECT txn_id, max(umn) AS umn FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '2020-01-01' AND business_type = 'MANDATE' AND txn_id IN (SELECT org_txn_id FROM pout0) GROUP BY txn_id
),
pout AS (SELECT org.umn, max(pout0.other_umn) AS other_umn, min(pout0.port_dt) AS port_dt FROM pout0 JOIN org ON org.txn_id = pout0.org_txn_id WHERE org.umn IS NOT NULL GROUP BY org.umn),
ports AS (
  SELECT 'IN' AS dir, umn, other_umn, port_dt, CASE WHEN regexp_like(lower(other_umn), '@(ptsbi|ptaxis|pthdfc|ptyes|paytm)$') THEN 1 ELSE 0 END AS internal FROM pin
  UNION ALL
  SELECT 'OUT', umn, other_umn, port_dt, 0 FROM pout
),
life AS (   -- every mandate txn on the Paytm UMNs since the start of the window (OUT: their whole history)
  SELECT t.umn, t.type, t.status, t.amount, DATE(t.created_on) AS d, t.created_on
  FROM switch.txn_info_snapshot_v3 t
  WHERE t.dl_last_updated >= DATE '2020-01-01' AND t.created_on < TIMESTAMP '{asof} 00:00:00'
    AND t.business_type = 'MANDATE' AND t.type IN ('COLLECT', 'REVOKE', 'PAUSE', 'UNPAUSE')
    AND t.umn IN (SELECT umn FROM ports)
),
agg AS (
  SELECT p.dir, p.umn,
    COUNT(CASE WHEN l.type = 'COLLECT' AND l.status = 'SUCCESS' THEN 1 END) AS exec_suc,
    COUNT(CASE WHEN l.type = 'COLLECT' AND l.status = 'FAILURE' THEN 1 END) AS exec_fail,
    COALESCE(SUM(CASE WHEN l.type = 'COLLECT' AND l.status = 'SUCCESS' THEN l.amount END), 0) AS gmv,
    max_by(CASE WHEN l.type IN ('REVOKE', 'PAUSE', 'UNPAUSE') AND l.status = 'SUCCESS' THEN l.type END, CASE WHEN l.type IN ('REVOKE', 'PAUSE', 'UNPAUSE') AND l.status = 'SUCCESS' THEN l.created_on END) AS last_ctl
  FROM ports p LEFT JOIN life l ON l.umn = p.umn AND (CASE WHEN p.dir = 'IN' THEN l.d >= p.port_dt ELSE l.d <= p.port_dt END)
  GROUP BY p.dir, p.umn
),
later_in AS (   -- Port-Ins after the window start, to find moves and come-backs
  SELECT prevumn, min(DATE(dl_last_updated)) AS d FROM upi_txn.upi_activities_data_snapshot_v3
  WHERE dl_last_updated >= DATE '{start}' AND dl_last_updated < DATE '{asof}' AND businesstype = 'MANDATE' AND purpose_code = 'BC' AND type = 'IN_PORT' AND status = 'SUCCESS'
  GROUP BY prevumn
)
SELECT p.dir, p.port_dt, p.umn, p.other_umn, p.internal,
  lower(substring(p.other_umn, position('@' IN p.other_umn) + 1)) AS other_handle,
  lower(substring(p.umn, position('@' IN p.umn) + 1)) AS paytm_handle,
  a.exec_suc, a.exec_fail, a.gmv,
  CASE a.last_ctl WHEN 'REVOKE' THEN 'REVOKED' WHEN 'PAUSE' THEN 'PAUSED' ELSE 'ACTIVE' END AS state,
  CASE WHEN p.dir = 'IN' AND o.umn IS NOT NULL THEN 'OUT' WHEN p.dir = 'IN' AND li.prevumn IS NOT NULL AND li.d > p.port_dt THEN 'MOVED'
       WHEN p.dir = 'OUT' AND lb.prevumn IS NOT NULL AND lb.d >= p.port_dt THEN 'BACK' ELSE '' END AS again
FROM ports p
JOIN agg a ON a.dir = p.dir AND a.umn = p.umn
LEFT JOIN (SELECT DISTINCT umn FROM pout) o ON p.dir = 'IN' AND o.umn = p.umn
LEFT JOIN later_in li ON p.dir = 'IN' AND li.prevumn = p.umn
LEFT JOIN later_in lb ON p.dir = 'OUT' AND lb.prevumn = p.other_umn

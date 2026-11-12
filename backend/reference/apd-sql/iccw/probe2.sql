-- Probe 1 Nov 2026: MCC 6011 payee txns - QR string (APP_DATA), extended_info keys, payee names; and any txn whose extended_info mentions cash / atm
with pe as (
  select txn_id, mcc, lower(handle) h, name, vpa from switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00' and participant_type = 'PAYEE' and mcc = '6011')
select pe.h, pe.name, pe.vpa, ti.status, ti.app_resp_code, ti.amount, json_extract_scalar(ti.extended_info,'$.APP_DATA') app_data,
       array_join(map_keys(cast(json_parse(ti.extended_info) as map(varchar, json))), ',') keys
from switch.txn_info_snapshot_v3 ti join pe on ti.txn_id = pe.txn_id
where ti.dl_last_updated >= date '2026-11-01' and ti.created_on >= timestamp '2026-11-01 00:00:00' and ti.created_on < timestamp '2026-11-02 00:00:00'
order by rand() limit 25

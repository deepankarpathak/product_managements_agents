-- Probe 1 Nov 2026: ICCW markers - extended_info purpose / refCategory values, APP_DATA mentioning atm/cash, payee name like ATM
with ti as (
  select txn_id, category, type, status, json_extract_scalar(extended_info,'$.purpose') pur, json_extract_scalar(extended_info,'$.refCategory') refc,
         json_extract_scalar(extended_info,'$.initiationMode') im,
         regexp_like(lower(coalesce(json_extract_scalar(extended_info,'$.APP_DATA'),'')), 'atm|cash|iccw|withdraw') qr_atm
  from switch.txn_info_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00'
    and category not in ('VPA2VPA','VPA2ACCOUNT')),
pe as (
  select txn_id, lower(handle) h, regexp_like(lower(coalesce(name,'')), '\batm\b|cash withdrawal|cardless') name_atm
  from switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00' and participant_type = 'PAYEE')
select category, type, pur, refc, im, qr_atm, name_atm, case when qr_atm or name_atm then h end h, count(*) n, count_if(status='SUCCESS') suc
from ti left join pe on ti.txn_id = pe.txn_id
group by 1,2,3,4,5,6,7,8
having qr_atm or name_atm or (pur not in ('00','14') and count(*) > 20)
order by n desc limit 80

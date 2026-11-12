-- Probe 1 Nov 2026: ICCW candidates = extended_info purpose '12' or initiationMode '18'; split by payee handle, payer handle, payee-name-has-ATM
with ti as (
  select txn_id, category, type, status, app_resp_code, json_extract_scalar(extended_info,'$.purpose') pur, json_extract_scalar(extended_info,'$.initiationMode') im, try_cast(amount as double) amt
  from switch.txn_info_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00'
    and (json_extract_scalar(extended_info,'$.purpose') = '12' or json_extract_scalar(extended_info,'$.initiationMode') = '18')),
pp as (
  select txn_id, max(case when participant_type='PAYEE' then lower(handle) end) payee_h, max(case when participant_type='PAYER' then lower(handle) end) payer_h,
         max(case when participant_type='PAYEE' then regexp_like(lower(coalesce(name,'')), 'atm') end) atm_name, max(case when participant_type='PAYEE' then mcc end) mcc
  from switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00' and txn_id in (select txn_id from ti)
  group by 1)
select category, type, pur, im, payee_h, mcc, atm_name, payer_h, count(*) n, count_if(status='SUCCESS') suc, round(avg(amt)) avg_amt
from ti join pp on ti.txn_id = pp.txn_id group by 1,2,3,4,5,6,7,8 order by n desc limit 40

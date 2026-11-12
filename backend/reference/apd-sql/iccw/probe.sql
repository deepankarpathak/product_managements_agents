-- Probe 1 Nov 2026: how ICCW (UPI cash withdrawal) appears in switch: categories, txn types, payee MCC 6011 by category / initiation mode / payee handle
with ti as (
  select txn_id, category, type, status, txn_mode, purpose, initiation_mode, json_extract_scalar(extended_info,'$.initiationMode') im
  from switch.txn_info_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00'),
pe as (
  select txn_id, mcc, lower(handle) h from switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '2026-11-01' and created_on >= timestamp '2026-11-01 00:00:00' and created_on < timestamp '2026-11-02 00:00:00' and participant_type = 'PAYEE')
select ti.category, ti.type, ti.txn_mode, coalesce(ti.initiation_mode, ti.im) im, ti.purpose, pe.mcc = '6011' mcc6011,
       case when pe.mcc = '6011' then pe.h end payee_handle, count(*) n, count_if(status='SUCCESS') suc
from ti left join pe on ti.txn_id = pe.txn_id
group by 1,2,3,4,5,6,7
having pe.mcc = '6011' or count(*) > 50000 or lower(ti.category) like '%atm%' or lower(ti.category) like '%cash%' or ti.txn_mode not in ('UPI','UPI_LITE')
order by n desc

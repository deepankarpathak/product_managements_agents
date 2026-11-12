-- Q: ICCW backfill, range {start} .. {end} (inclusive), split per day by backfill.py (same logic as iccw_day.sql): attempts / success / failures / amount / users
--    by purpose x (total, acquirer = payee handle, payer handle, remitter bank, failure code, code x acquirer, code x remitter bank, amount band, hour)
-- ICCW identifiers (user, 2026-11-02): ONLY payee MCC = '6013' AND extended_info purpose in ('12', '13') — no other condition (no initiation mode / type filter)
--   purpose '12' acquirers seen: @sbi, @hdfcbank, @barodampay, @pnb, @cbin ...; purpose '13': @india1, @hpy, @vakrangee, @hdfcbank ...
--   (MCC 6011 is NOT ICCW on Paytm: it is microfinance loan EMIs)
-- Scope (not an ICCW identifier): payer handle in the Paytm 5 (paytm, ptyes, ptaxis, pthdfc, ptsbi), as on every tab; one row per txn_id
-- Code = app_resp_code for FAILURE (status name for PENDING / DEEMED); side = which participant leg carries resp_code
with ti as (
  select txn_id, date(created_on) d, status, hour(created_on) hr, try_cast(amount as double) amt,
         coalesce(json_extract_scalar(extended_info, '$.purpose'), 'NA') purpose,
         case when status = 'SUCCESS' then 'SUCCESS' when status = 'FAILURE' then coalesce(app_resp_code, 'NULL') else status end code,
         coalesce(npci_resp_code, '') npci
  from switch.txn_info_snapshot_v3
  where dl_last_updated >= date '{start}' and created_on >= timestamp '{start} 00:00:00' and created_on < timestamp '{end} 00:00:00' + interval '1' day
    and (extended_info like '%"purpose": "1%' or extended_info like '%"purpose":"1%') and json_extract_scalar(extended_info, '$.purpose') in ('12', '13')),
pp as (
  select txn_id,
         max(case when participant_type = 'PAYER' then lower(handle) end) payer_handle,
         max(case when participant_type = 'PAYER' then bank_code end) payer_bank,
         max(case when participant_type = 'PAYER' then scope_cust_id end) cid,
         max(case when participant_type = 'PAYEE' then lower(handle) end) payee_handle,
         max(case when participant_type = 'PAYEE' then mcc end) payee_mcc,
         max(case when participant_type = 'PAYER' and resp_code is not null and resp_code not in ('00', '') then 1 else 0 end) payer_rc,
         max(case when participant_type = 'PAYEE' and resp_code is not null and resp_code not in ('00', '') then 1 else 0 end) payee_rc
  from switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '{start}' and created_on >= timestamp '{start} 00:00:00' and created_on < timestamp '{end} 00:00:00' + interval '1' day
    and txn_id in (select txn_id from ti)
  group by 1),
y as (
  select ti.*, coalesce(pp.payer_handle, 'NULL') payer_handle, coalesce(pp.payer_bank, 'NULL') payer_bank, coalesce(pp.payee_handle, 'NULL') payee_handle, pp.cid,
         case when ti.code in ('SUCCESS') then '' when pp.payer_rc = 1 and pp.payee_rc = 0 then 'PAYER' when pp.payee_rc = 1 and pp.payer_rc = 0 then 'PAYEE'
              when pp.payer_rc = 1 and pp.payee_rc = 1 then 'BOTH' else 'NONE' end side,
         case when ti.amt < 500 then '1 <500' when ti.amt < 1000 then '2 500-999' when ti.amt < 2000 then '3 1000-1999' when ti.amt < 5000 then '4 2000-4999'
              when ti.amt < 10000 then '5 5000-9999' else '6 10000+' end band
  from ti join pp on ti.txn_id = pp.txn_id
  where pp.payee_mcc = '6013' and pp.payer_handle in ('paytm', 'ptyes', 'ptaxis', 'pthdfc', 'ptsbi'))
select d dt, purpose,
       case when grouping(payee_handle, payer_handle, payer_bank, code, band, hr) = 63 then 'TOTAL'
            when grouping(code) = 0 and grouping(payee_handle) = 0 then 'CODE_PAYEE'
            when grouping(code) = 0 and grouping(payer_bank) = 0 then 'CODE_BANK'
            when grouping(code) = 0 then 'CODE'
            when grouping(payee_handle) = 0 then 'PAYEE_HANDLE'
            when grouping(payer_handle) = 0 then 'PAYER_HANDLE'
            when grouping(payer_bank) = 0 then 'PAYER_BANK'
            when grouping(band) = 0 then 'AMOUNT'
            else 'HOUR' end dim,
       case when grouping(code) = 0 and grouping(payee_handle) = 0 then code || '|' || payee_handle
            when grouping(code) = 0 and grouping(payer_bank) = 0 then code || '|' || payer_bank
            when grouping(code) = 0 then code
            when grouping(payee_handle) = 0 then payee_handle
            when grouping(payer_handle) = 0 then payer_handle
            when grouping(payer_bank) = 0 then payer_bank
            when grouping(band) = 0 then band
            when grouping(hr) = 0 then cast(hr as varchar) else '' end k,
       case when grouping(code) = 0 and grouping(payee_handle) = 1 and grouping(payer_bank) = 1 then max(npci) else '' end npci,
       case when grouping(code) = 0 and grouping(payee_handle) = 1 and grouping(payer_bank) = 1 then max_by(side, side_n) else '' end side,
       count(*) att, count_if(status = 'SUCCESS') suc, count_if(status = 'FAILURE') fail,
       sum(amt) amt, sum(case when status = 'SUCCESS' then amt else 0 end) suc_amt, count(distinct cid) users
from (select y.*, count(*) over (partition by d, purpose, code, side) side_n from y) y
group by grouping sets ((d, purpose), (d, purpose, payee_handle), (d, purpose, payer_handle), (d, purpose, payer_bank), (d, purpose, code),
                        (d, purpose, code, payee_handle), (d, purpose, code, payer_bank), (d, purpose, band), (d, purpose, hr))

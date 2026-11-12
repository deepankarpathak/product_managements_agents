-- UPI Global (International) activations NOT completed, {S} .. {E}: why. One row per day x PSP x bank x new/existing x reason x step.
-- Base = sql/activation.sql rows with status <> 'ACTIVE' (account_activation_snapshot_v3, service INTERNATIONAL, by updated_on day).
-- The activation table has no reason column (extended_info empty), so the reason comes from tpap_pms.upi_user_activity_log (same customer_id, same day to 06:00 next day):
--   meta.app.v1.account.service.action              = the activation request (106 = PENDING_ASYNC: accepted, result comes later)
--   meta.app.v1.account.service.action.check.status = the app polling the result
-- reason = last FAILURE code of the day other than 0 / 106; else VALIDITY_ENDED (val_end <= day), TURNED_OFF (request succeeded but account inactive),
--          NO_FINAL_RESPONSE (request pending, polls returned no failure and no activation: usually the user left at UPI PIN entry or the bank never confirmed), NO_LOG.
-- The log carries no service name: a BIO_AUTH request by the same customer the same day can add rows (small, checked 2 Nov).
with a as (
  select a.id, a.customer_id, date(a.updated_on) d, u.psp_id, coalesce(a.account_provider_ifsc, 'NULL') bank,
         date(a.created_on) = date(a.updated_on) is_new, date(a.val_end) <= date(a.updated_on) window_ended
  from hive.tpap_pms.account_activation_snapshot_v3 a
  join hive.tpap_pms.user_snapshot_v3 u on u.id = cast(a.user_id as bigint) and u.dl_last_updated <= current_date
  where a.dl_last_updated >= date '{S}' and a.service_name = 'INTERNATIONAL' and a.status <> 'ACTIVE'
    and a.updated_on >= timestamp '{S} 00:00:00' and a.updated_on < timestamp '{E1} 00:00:00'),
l as (
  select customer_id, replace(action, 'meta.app.v1.account.service.', '') step, status, coalesce(resp_code, '-') rc, created_time_datalake t
  from hive.tpap_pms.upi_user_activity_log_to_dwh_snapshot_v3
  where dl_last_updated >= date '{S}' and created_time_datalake >= timestamp '{S} 00:00:00' and created_time_datalake < timestamp '{E1} 06:00:00'
    and action in ('meta.app.v1.account.service.action', 'meta.app.v1.account.service.action.check.status')
    and customer_id in (select customer_id from a)),
j as (
  select a.id, a.d, a.psp_id, a.bank, a.is_new, a.window_ended,
         max_by(case when l.status = 'FAILURE' and l.rc not in ('0', '106', '-') then l.rc end, case when l.status = 'FAILURE' and l.rc not in ('0', '106', '-') then l.t end) fail_code,
         max_by(case when l.status = 'FAILURE' and l.rc not in ('0', '106', '-') then l.step end, case when l.status = 'FAILURE' and l.rc not in ('0', '106', '-') then l.t end) fail_step,
         count_if(l.step = 'action' and l.status = 'SUCCESS') act_ok, count(l.customer_id) log_rows
  from a left join l on l.customer_id = a.customer_id and l.t >= cast(a.d as timestamp) and l.t < cast(a.d as timestamp) + interval '30' hour
  group by 1, 2, 3, 4, 5, 6)
select d, psp_id, bank, is_new,
       coalesce(fail_code, case when window_ended then 'VALIDITY_ENDED' when act_ok > 0 then 'TURNED_OFF' when log_rows = 0 then 'NO_LOG' else 'NO_FINAL_RESPONSE' end) reason,
       coalesce(fail_step, '-') step, count(*) n
from j group by 1, 2, 3, 4, 5, 6

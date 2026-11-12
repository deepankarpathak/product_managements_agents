-- UPI Global (International) dashboard base pull: one row per UPI_GLOBAL txn, {S} .. {E} (inclusive, created_on IST as stored).
-- Same scope as Queries/UPI Global/q3/q4 (txn_mode = 'UPI_GLOBAL'); adds payer / payee participant fields (no VPA, name, account, device or location)
-- and the international fields from extended_info (base currency / amount, FX rate, markup fee, country, app, merchant flags).
with t as (
  select txn_id, created_on, status, npci_resp_code, app_resp_code, cast(amount as double) amount, type, category, psp_handle, channel_code,
         json_extract_scalar(extended_info, '$.baseCurr') base_curr,
         try_cast(json_extract_scalar(extended_info, '$.baseAmount') as double) base_amt,
         try_cast(json_extract_scalar(extended_info, '$.fxRate') as double) fx_rate,
         try_cast(json_extract_scalar(extended_info, '$.mkupFee') as double) mkup_fee,
         json_extract_scalar(extended_info, '$.countryCode') country,
         json_extract_scalar(extended_info, '$.payerOsApp') os_app,
         json_extract_scalar(extended_info, '$.appVersion') app_ver,
         json_extract_scalar(extended_info, '$.businessSize') biz_size,
         json_extract_scalar(extended_info, '$.payeeMerchantGenre') m_genre,
         json_extract_scalar(extended_info, '$.isVerifiedMerchant') m_verified,
         json_extract_scalar(extended_info, '$.refCategory') ref_cat,
         json_extract_scalar(extended_info, '$.initiationMode') init_mode,
         json_extract_scalar(extended_info, '$.purpose') purpose,
         json_extract_scalar(extended_info, '$.isMigrationFlow') migration,
         json_extract_scalar(extended_info, '$.isBioAuthTxn') bio_auth,
         json_extract_scalar(extended_info, '$.scanner_entrypoint') scan_entry,
         json_extract_scalar(extended_info, '$.deviceBinded') dev_bound,
         json_extract_scalar(extended_info, '$.userConsentForIntlTxn') intl_consent,
         -- hours since device binding (oauthDeviceBindingTime = epoch ms UTC; created_on is IST, so -5.5 h). Cooling period = first 72 h.
         round((to_unixtime(created_on) - 19800 - try_cast(json_extract_scalar(extended_info, '$.oauthDeviceBindingTime') as double) / 1000) / 3600, 1) bind_age_h,
         -- coarse payer location flag only (no coordinates leave the query): none / India / outside India
         case when try_cast(json_extract_scalar(extended_info, '$.latitude') as double) is null
                or (try_cast(json_extract_scalar(extended_info, '$.latitude') as double) = 0 and try_cast(json_extract_scalar(extended_info, '$.longitude') as double) = 0) then 'none'
              when try_cast(json_extract_scalar(extended_info, '$.latitude') as double) between 6 and 37.5
               and try_cast(json_extract_scalar(extended_info, '$.longitude') as double) between 68 and 97.5 then 'India box' else 'outside India' end loc
  from hive.switch.txn_info_snapshot_v3
  where dl_last_updated >= date '{S}' and txn_mode = 'UPI_GLOBAL'
    and created_on >= timestamp '{S} 00:00:00' and created_on < timestamp '{E1} 00:00:00'),
p as (
  select txn_id,
         max(case when participant_type = 'PAYER' then handle end) payer_handle,
         max(case when participant_type = 'PAYER' then bank_code end) payer_bank,
         max(case when participant_type = 'PAYER' then account_type end) payer_acc_type,
         max(case when participant_type = 'PAYER' then resp_code end) payer_resp,
         max(case when participant_type = 'PAYEE' then handle end) payee_handle,
         max(case when participant_type = 'PAYEE' then bank_code end) payee_bank,
         max(case when participant_type = 'PAYEE' then mcc end) payee_mcc,
         max(case when participant_type = 'PAYEE' then resp_code end) payee_resp
  from hive.switch.txn_participants_snapshot_v3
  where dl_last_updated >= date '{S}' and created_on >= timestamp '{S} 00:00:00' and created_on < timestamp '{E2} 00:00:00'
    and txn_id in (select txn_id from t)
  group by txn_id)
select format_datetime(t.created_on, 'yyyy-MM-dd HH:mm') ts, t.status, t.npci_resp_code npci, t.app_resp_code app, t.amount, t.type, t.category,
       t.psp_handle, t.channel_code, p.payer_handle, p.payer_bank, p.payer_acc_type, p.payer_resp, p.payee_handle, p.payee_bank, p.payee_mcc, p.payee_resp,
       t.base_curr, t.base_amt, t.fx_rate, t.mkup_fee, t.country, t.os_app, t.app_ver, t.biz_size, t.m_genre, t.m_verified, t.ref_cat, t.init_mode,
       t.purpose, t.migration, t.bio_auth, t.scan_entry, t.dev_bound, t.intl_consent, t.bind_age_h, t.loc
from t left join p on p.txn_id = t.txn_id

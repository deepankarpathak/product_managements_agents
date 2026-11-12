# trino-dwh — schema

Table names and grain below are taken from the Unified SR Dashboard queries (`backend/unifiedDashboard.js`). Column lists are partial; **TBD** means confirm with `DESCRIBE <table>` before relying on it.

| Table | Grain | What it holds |
|---|---|---|
| `team_product.LOOKER_TPAP_Txns_V3` | day × payer handle × flow × bank × codes (aggregated) | Day-level TPAP txn counts for SR breakdown. Columns used: `dt`, `payer_handle`, `p2p_p2m_flag`. Banks IFSC-prefix grouped; a few small banks are filed under "Others" (JIOP, NESF, SURY, NSPB broken out from raw txns). |
| `team_product.LOOKER_Day_Level_DTU_TPU` | day level | DTU / TPU volume numbers used by the dashboard. |
| `switch.txn_info_snapshot_v3` | 1 row per txn | Raw txn: `txn_id`, `created_on`, `status`, `app_resp_code`, `npci_resp_code`, `psp_handle`, `category`, `type`, `business_type`, `dl_last_updated` (partition). |
| `switch.txn_participants_snapshot_v3` | 1 row per participant per txn | Payer/payee side: `txn_id`, `participant_type` (PAYER / PAYEE), `bank_code`, `handle`, `detail_2`. |

## Derived dimensions (as the dashboard defines them)
- **flow**: `category IN ('VPA2VPA','VPA2ACCOUNT')` → P2P; else P2M (`VPA2MERCHANT`). Day table: `p2p_p2m_flag`, may also be LITE / Others.
- **payer handle**: ptyes / ptaxis / ptsbi / pthdfc / paytm.
- **decline type**: BD (business decline, customer side), TD (technical decline), RD (risk decline).

## Join keys
- `txn_info_snapshot_v3.txn_id` = `txn_participants_snapshot_v3.txn_id`. Join PAYER rows for the payer bank.
- Day tables do not join to raw txns; compare at (date, handle, flow, bank).

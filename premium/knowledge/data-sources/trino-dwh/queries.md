# trino-dwh — proven queries

Adapted from the Unified SR Dashboard's own SQL. Replace `{{...}}`. Only add queries here after they have produced a finding.

## Payer-bank SR by day (raw txns)
```sql
WITH t AS (
  SELECT txn_id, created_on, status, npci_resp_code, psp_handle AS handle
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM}}' AND created_on < TIMESTAMP '{{TO}}'
    AND business_type IS NULL AND type IN ('PAY','COLLECT')
    AND category IN ('VPA2VPA','VPA2ACCOUNT','VPA2MERCHANT')
    AND psp_handle IN ({{HANDLES}})
), p AS (
  SELECT txn_id, bank_code
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM_PAD}}' AND created_on < TIMESTAMP '{{TO_PAD}}'
    AND participant_type = 'PAYER' AND handle IN ({{HANDLES}})
)
SELECT date(t.created_on) AS d, count(*) AS total,
       count_if(t.status = 'SUCCESS') AS success
FROM t JOIN p ON p.txn_id = t.txn_id
WHERE p.bank_code = '{{BANK}}'
GROUP BY 1 ORDER BY 1
```
`status` success literal is **TBD** — confirm with `SELECT DISTINCT status` on a one-day slice first.

## Failure code mix for one bank (change vs baseline)
Same CTEs; replace the SELECT with `SELECT t.npci_resp_code, count(*) FROM t JOIN p ON ... WHERE p.bank_code='{{BANK}}' AND t.status <> 'SUCCESS' GROUP BY 1 ORDER BY 2 DESC`, run once for the "now" window and once for the baseline, compare share of the bank's attempts.

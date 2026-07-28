---
name: fetch-umn
description: >
  Fetch full UMN (UPI Mandate Number) details from the Switch database including mandate status,
  payer/payee participant info, last execution date, and last debit amount. Trigger this skill
  whenever the user runs /fetchUMN, asks to "look up a UMN", "check mandate status", "get
  participants for UMN", "last execution details for a mandate", or pastes a UMN hash like
  'abc123@ptyes' or 'abc123@ptsbi'. Also trigger when the user asks for transaction history
  on a mandate or wants to debug why a mandate execution failed. This skill queries the Switch
  Redash instance (redash-ptybl) and renders a structured summary.
---

# /fetchUMN — UMN Lookup Skill

Fetch mandate status, participants, and last execution details for any UMN from the Switch database.

**Trigger:** `/fetchUMN <UMN>` or any request to look up a mandate by UMN.

---

## Input

- **UMN** (required): The full UMN string, e.g. `9b7cd4139d8d48f2b2635b26928a27c9@ptyes`
- UMN format: `<32-char hex hash>@<handle>` — handles include `ptyes`, `ptsbi`, `paytm`, etc.

---

## Workflow

### Step 1 — Parse and validate the UMN

Extract the UMN from the user's message. If no UMN is found, ask for it:

```
Which UMN do you want to look up?
```

Validate format: must contain `@` and a recognizable handle. If the format looks wrong, flag it and confirm before proceeding.

---

### Step 2 — Determine the Redash instance

| UMN handle | Redash instance |
|------------|-----------------|
| `@ptyes`   | `redash-ptybl`  |
| `@ptsbi`   | `redash-ptybl`  |
| `@paytm`   | `redash-ptybl`  |
| Unknown    | Try `redash-ptybl` first, then `redash-tpap` if no results |

---

### Step 3 — Run all three queries in parallel

Run queries Q1, Q2, and Q3 together. Do not wait for one to finish before starting the next.

---

#### Q1 — Mandate status + participants + last execution (primary query)

This is the most important query. Run it first and treat its output as the main result.

```sql
SELECT
  si.umn,
  si.mandate_status,
  si.revocable,
  si.created_on       AS mandate_created_on,
  si.updated_on       AS mandate_updated_on,
  payer.vpa           AS payer_vpa,
  payer.name          AS payer_name,
  payer.handle        AS payer_handle,
  payer.bank_code     AS payer_bank_code,
  payer.acc_ref_id    AS payer_acc_ref_id,
  payee.vpa           AS payee_vpa,
  payee.name          AS payee_name,
  payee.handle        AS payee_handle,
  payee.bank_code     AS payee_bank_code,
  payee.mcc           AS payee_mcc,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastSuccessDebitDate'))   AS last_success_debit_date,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastSuccessDebitAmount')) AS last_success_debit_amount,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastExecutionRespCode'))  AS last_execution_resp_code
FROM standing_instructions si
LEFT JOIN standing_instructions_participants payer
  ON payer.txn_id = si.txn_id AND payer.participant_type = 'PAYER'
LEFT JOIN standing_instructions_participants payee
  ON payee.txn_id = si.txn_id AND payee.participant_type = 'PAYEE'
WHERE si.umn = '<UMN>'
LIMIT 1;
```

**Note on Q4 in original reference:** The original query used `txn_participants` for `payee.mcc` via a `tp_payee` join but joined `standing_instructions_participants` for payer/payee VPAs. This skill uses `standing_instructions_participants` for all participant fields (including MCC) for consistency — both tables exist on Switch, but `standing_instructions_participants` is the canonical source for mandate participant data. If `mcc` is null in results, optionally fall back to Q3.

---

#### Q2 — Recent transaction history on the mandate

```sql
SELECT
  txn_id,
  rrn,
  category,
  type,
  business_type,
  npci_resp_code,
  amount,
  status,
  app_resp_code,
  npci_ts,
  created_on,
  updated_on,
  psp_handle
FROM txn_info
WHERE umn = '<UMN>'
ORDER BY updated_on DESC
LIMIT 10;
```

---

#### Q3 — Raw SI participant details (fallback / supplementary)

```sql
SELECT
  umn,
  mcc,
  participant_type,
  resp_code,
  created_on,
  updated_on,
  bank_code,
  handle,
  txn_id,
  acc_ref_id
FROM standing_instructions_participants
WHERE umn = '<UMN>'
ORDER BY participant_type;
```

---

### Step 4 — Handle errors

| Situation | Action |
|-----------|--------|
| Q1 returns 0 rows | Check if the UMN handle matches the Redash instance. Try the other instance. If still empty, report "UMN not found" |
| Q2 returns 0 rows | Show "No transaction history found" — this is valid for newly created mandates |
| `mandate_status` is NULL | Data integrity issue — flag it explicitly in the output |
| `last_success_debit_date` / `last_success_debit_amount` both NULL | Report "No successful execution recorded" — do not infer from txn_info |
| JSON_EXTRACT returns `null` string | Treat as NULL and show as "—" |

---

### Step 5 — Render the output

Format as a structured summary. Keep it scannable.

```
## UMN Lookup: <UMN>

### Mandate Status
| Field              | Value        |
|--------------------|--------------|
| Status             | <ACTIVE / PAUSED / REVOKED / EXPIRED> |
| Revocable          | <Yes / No>   |
| Created On         | <datetime>   |
| Last Updated       | <datetime>   |

### Participants
| Role  | VPA            | Name      | Bank Code | Handle  |
|-------|----------------|-----------|-----------|---------|
| Payer | <payer_vpa>    | <name>    | <code>    | <handle>|
| Payee | <payee_vpa>    | <name>    | <code>    | <handle>|

Payee MCC: <mcc or "—">

### Last Execution
| Field                  | Value         |
|------------------------|---------------|
| Last Success Debit Date   | <date or "No execution recorded"> |
| Last Success Debit Amount | ₹<amount or "—"> |
| Last Execution Resp Code  | <code> — <description if known> |

### Recent Transactions (last 10)
| TXN ID | RRN | Category | Type | Amount | Status | NPCI Code | Updated On |
|--------|-----|----------|------|--------|--------|-----------|------------|
| ...    | ... | ...      | ...  | ₹...   | ...    | ...       | ...        |

---
_Source: Switch DB via Redash · Queried: <timestamp>_
```

---

### Step 6 — Annotate known resp codes

If `last_execution_resp_code` or `npci_resp_code` is present, add a brief inline label where known:

| Code | Meaning |
|------|---------|
| `00` | Success |
| `U30` | Beneficiary bank offline |
| `U16` | Insufficient funds |
| `U69` | Request timed out |
| `U91` | Bank not reachable |
| `ZM` | Invalid MPIN |
| `Z9` | System exception |
| `BT` | Transaction blocked |

If the code isn't in this list, show the raw code without inventing a label.

---

## Tips

- Always run Q1 — it gives mandate status + participants + last execution in a single query. Q2 and Q3 are supplementary.
- If `last_success_debit_date` comes back as `null` string (from JSON_UNQUOTE), treat it as no execution yet — this is common for mandates that have been created but never executed.
- The `txn_info` table is high-volume. Limiting to 10 rows and ordering by `updated_on DESC` keeps the query fast.
- `standing_instructions.txn_id` is the mandate creation transaction ID — all participant lookups join on this, not on the execution transaction IDs in `txn_info`.
- `mandate_status` values in Switch: `CREATED`, `ACTIVE`, `PAUSED`, `REVOKED`, `EXPIRED`, `FAILED`. Some older records may have raw NPCI status codes instead.
- If the user asks to check multiple UMNs, run all queries in parallel for each UMN rather than sequentially.

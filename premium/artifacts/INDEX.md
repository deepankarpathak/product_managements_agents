# Artifacts Index

A typed registry of all artifacts in this product workspace. Skills append to the relevant section at write time; back-edits update status/links.

## Hypotheses (open)
| ID | Slug | Status | Cohort | Created | Last touched | Related |
|----|------|--------|--------|---------|-------------|---------|
| (none yet) | | | | | | |

## Hypotheses (closed)
| ID | Slug | Final status | Resolution | Created | Closed |
|----|------|--------------|------------|---------|--------|
| (none yet) | | | | | |

## Investigations
| ID | Slug | Status | Foundation | Confidence | Created |
|----|------|--------|------------|------------|---------|
| INV-idib-sr-up-2026-10-21 | idib-sr-up-rca-2026-10-21 | CLOSED-NON-ISSUE | IDIB payer SR P2M 10-19 vs L7D (brief iel6/gbtg) | HIGH | 2026-10-21 |
| INV-ibkl-sr-drop-2026-10-21 | ibkl-sr-drop-rca-2026-10-21 | SUSPECTED | IBKL payer SR P2M 10-20 vs L7D (brief dfsf) | MEDIUM | 2026-10-21 |
| INV-icic-sr-dip-2026-10-28 | icic-sr-dip-rca-2026-10-28 | CLOSED-NON-ISSUE | ICIC payer SR all flows 10-26 vs L7D (brief z8pe) | HIGH | 2026-10-28 |
| INV-bkid-sr-drop-2026-10-28 | bkid-sr-drop-rca-2026-10-28 | CONFIRMED | BKID payer SR all flows 10-26 vs L7D (brief 1m3v) | MEDIUM | 2026-10-28 |
| INV-cbin-sr-drop-2026-10-28 | cbin-sr-drop-rca-2026-10-28 | CONFIRMED | CBIN payer SR 10-27 vs L7D; U30-B3 retry storm on @ptyes (brief 1cte) | MEDIUM | 2026-10-28 |
| INV-hdfc-b3-rise-2026-10-28 | hdfc-b3-rise-rca-2026-10-28 | CONFIRMED | HDFC payer U30-B3 10-26→27 vs 10-13→25 (no brief) | MEDIUM | 2026-10-28 |
| INV-karb-sr-drop-2026-11-02 | karb-sr-drop-rca-2026-11-02 | CONFIRMED | KARB payer SR 11-01 vs L7D; month-end midnight U28 outage (brief ldsa) | HIGH | 2026-11-02 |
| INV-fino-sr-drop-2026-11-02 | fino-sr-drop-rca-2026-11-02 | SUSPECTED | FINO payer SR 11-01 vs L7D; FINO-only month-start U30-Z9 (brief zplg) | MEDIUM | 2026-11-02 |
| INV-utib-sr-drop-2026-11-05 | utib-sr-drop-rca-2026-11-05 | CONFIRMED | UTIB payer SR 11-04 vs L7D; Axis-side U30-YI/U67-UT windows 02:10–02:38 + 18:18–20:39, recurring (brief hwq0) | HIGH | 2026-11-05 |

## Reports
| Slug | Type (explore/decide) | Cohort | Date | Hypotheses generated |
|------|----------------------|--------|------|---------------------|
| (none yet) | | | | |

## Tickets
| ID | Title | Priority | Status (pending/shipped/verified) | Foundation | Filed |
|----|-------|----------|----------------------------------|------------|-------|
| (none yet) | | | | | |

## Data files
| Slug | Source | Date pulled | Referenced by |
|------|--------|-------------|---------------|
| idib-sr-up-investigate-2026-10-21/idib-sr-daily | trino-dwh | 2026-10-21 | INV-idib-sr-up-2026-10-21 |
| ibkl-sr-drop-investigate-2026-10-21/q0-sr-daily | trino-dwh | 2026-10-21 | INV-ibkl-sr-drop-2026-10-21 |
| ibkl-sr-drop-investigate-2026-10-21/q1-code-mix | trino-dwh | 2026-10-21 | INV-ibkl-sr-drop-2026-10-21 |
| ibkl-sr-drop-investigate-2026-10-21/q5-codes-by-bank | trino-dwh | 2026-10-21 | INV-ibkl-sr-drop-2026-10-21 |
| ibkl-sr-drop-investigate-2026-10-21/q2-handle-hour | trino-dwh | 2026-10-21 | INV-ibkl-sr-drop-2026-10-21 |
| ibkl-sr-drop-investigate-2026-10-21/q3-minute-windows | trino-dwh | 2026-10-21 | INV-ibkl-sr-drop-2026-10-21 |
| icic-sr-dip-investigate-2026-10-28/q0-day-bank-sr-codes | trino-dwh | 2026-10-28 | INV-icic-sr-dip-2026-10-28 |
| bkid-sr-drop-investigate-2026-10-28/q2-hour-1026 | trino-dwh | 2026-10-28 | INV-bkid-sr-drop-2026-10-28 |
| bkid-sr-drop-investigate-2026-10-28/q3-minute-1026 | trino-dwh | 2026-10-28 | INV-bkid-sr-drop-2026-10-28 |
| bkid-sr-drop-investigate-2026-10-28/q4-hour-1027 | trino-dwh | 2026-10-28 | INV-bkid-sr-drop-2026-10-28 |
| bkid-sr-drop-investigate-2026-10-28/q5-minute-1024 | trino-dwh | 2026-10-28 | INV-bkid-sr-drop-2026-10-28 |
| bkid-sr-drop-investigate-2026-10-28/q6-u90-samples-1026 | trino-dwh | 2026-10-28 | INV-bkid-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q2-hour-1027 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q3-peers-2026-10-20 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28, INV-hdfc-b3-rise-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q4-handle-flow-hour-2026-10-20 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q5a-top-payees-2026-10-20 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q5b-payer-buckets-2026-10-20 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q3-peers-2026-10-27 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28, INV-hdfc-b3-rise-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q4-handle-flow-hour-2026-10-27 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28, INV-hdfc-b3-rise-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q5a-top-payees-2026-10-27 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| cbin-sr-drop-investigate-2026-10-28/q5b-payer-buckets-2026-10-27 | trino-dwh | 2026-10-28 | INV-cbin-sr-drop-2026-10-28 |
| hdfc-b3-rise-investigate-2026-10-28/q1-daily-looker | trino-dwh | 2026-10-28 | INV-hdfc-b3-rise-2026-10-28 |
| hdfc-b3-rise-investigate-2026-10-28/q2-hour-1026 | trino-dwh | 2026-10-28 | INV-hdfc-b3-rise-2026-10-28 |
| hdfc-b3-rise-investigate-2026-10-28/q3-amount-2026-10-20 | trino-dwh | 2026-10-28 | INV-hdfc-b3-rise-2026-10-28 |
| hdfc-b3-rise-investigate-2026-10-28/q3-amount-2026-10-27 | trino-dwh | 2026-10-28 | INV-hdfc-b3-rise-2026-10-28 |
| hdfc-b3-rise-investigate-2026-10-28/q4-hour-1028 | trino-dwh | 2026-10-28 | INV-hdfc-b3-rise-2026-10-28 |
| karb-sr-drop-investigate-2026-11-02/q1-banks-2026-10-25 | trino-dwh | 2026-11-02 | INV-karb-sr-drop-2026-11-02 |
| karb-sr-drop-investigate-2026-11-02/q1-banks-2026-11-01 | trino-dwh | 2026-11-02 | INV-karb-sr-drop-2026-11-02 |
| karb-sr-drop-investigate-2026-11-02/q2-int1452-1101 | trino-dwh | 2026-11-02 | INV-karb-sr-drop-2026-11-02 |
| karb-sr-drop-investigate-2026-11-02/q3-minute-midnight | trino-dwh | 2026-11-02 | INV-karb-sr-drop-2026-11-02 |
| karb-sr-drop-investigate-2026-11-02/q4-int1452-codepair-1101 | trino-dwh | 2026-11-02 | INV-karb-sr-drop-2026-11-02 |
| fino-sr-drop-investigate-2026-11-02/q1-peers-2026-10-25 | trino-dwh | 2026-11-02 | INV-fino-sr-drop-2026-11-02 |
| fino-sr-drop-investigate-2026-11-02/q1-peers-2026-11-01 | trino-dwh | 2026-11-02 | INV-fino-sr-drop-2026-11-02 |
| fino-sr-drop-investigate-2026-11-02/q2-fino-hour-1101 | trino-dwh | 2026-11-02 | INV-fino-sr-drop-2026-11-02 |
| fino-sr-drop-investigate-2026-11-02/q3-daily-looker | trino-dwh | 2026-11-02 | INV-fino-sr-drop-2026-11-02 |
| utib-sr-drop-investigate-2026-11-05/q1-hour-1104 | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |
| utib-sr-drop-investigate-2026-11-05/q2-minute-windows-1104 | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |
| utib-sr-drop-investigate-2026-11-05/q3-codes-02h-vs-base-1104 | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |
| utib-sr-drop-investigate-2026-11-05/q4-peers-windows-1104 | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |
| utib-sr-drop-investigate-2026-11-05/q5-daily-looker | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |
| utib-sr-drop-investigate-2026-11-05/q6-payee-side-windows-1104 | trino-dwh | 2026-11-05 | INV-utib-sr-drop-2026-11-05 |

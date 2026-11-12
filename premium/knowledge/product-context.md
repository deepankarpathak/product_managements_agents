# Product Context

Neutral facts only. Numbers live in the dashboards, not here.

### Product Overview
UPI third-party app provider (TPAP) payments: P2P and P2M pay/collect transactions routed through the switch to NPCI and remitter (payer) banks. Success rate (SR) = successful txns / attempts, tracked by the Unified SR Dashboard (`#srdash`) and the Success Rate Snippet (`#srsnippet`).

### Vocabulary
- **Payer / remitter bank**: bank of the paying account, keyed by IFSC prefix (e.g. SBIN, HDFC). Small banks are grouped under "Others" in the day table.
- **Payer handle**: ptyes, ptaxis, ptsbi, pthdfc, paytm.
- **Flow**: P2P (VPA2VPA, VPA2ACCOUNT) or P2M (VPA2MERCHANT); day table may add LITE / Others.
- **Decline types**: BD (business decline, customer side), TD (technical decline), RD (risk decline).
- **Windows**: "yesterday vs L7D" or "MTD vs LMTD". Baseline = L7D or LMTD.
- **WARN / CRIT** (dashboard alert rule): SR ≥1pp / ≥3pp below L7D and ≥0.1pp / ≥0.3pp hit to overall SR.

### Business Metrics
Overall SR, payer-bank SR and its contribution to overall SR change, error-code share of attempts. **Source:** Unified SR Dashboard sections A–K. **Definition:** contribution = bank's share-weighted SR change; code share = % of the bank's attempts.

### User Journey
Not applicable to this workspace's current scope (payment success analysis, not an app funnel).

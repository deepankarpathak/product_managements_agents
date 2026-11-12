# Error Code → User Message Mapping

**Status:** Populated by `/document-update` as error codes are discovered during analysis.

---

## Format

| Code | Source | User Message | Notes |
|---|---|---|---|
| `<CODE>` | `<API / system>` | `<exact text the user sees>` | `<one-line context: is it success? failure? known bug?>` |

---

## Example shape (placeholder only — no concrete codes or product-specific systems)

| Code | Source | User Message | Notes |
|---|---|---|---|
| `<CODE_A>` | `<source / API name>` | `<exact text the user sees>` | `<context: success / failure / retry / known bug>` |
| `<CODE_B>` | `<source / API name>` | `<exact text>` | `<watch out — this code's name implies failure but it's actually success>` |

The second row's note pattern is a real gotcha to capture: codes named like failures that are actually successes. Use the structure, fill with real codes from this product.

---

## Rules for Appending

- Every new code must have all 4 fields filled
- If the user message is uncertain, leave it blank and add a note: "User message not yet verified"
- Do NOT classify codes as success/failure based on the name. The PM or tech team must confirm.
- If two codes map to the same user message, list both rows — do not merge
- **Do NOT include frequencies, counts, or rates.** "Affects 8% of users" or "10,000 events/day" does NOT belong here. The mapping is qualitative (code → message). Volume / frequency lives in session logs or artifacts, referenced by a date.

# How to Register a New Data Source

**Purpose:** Prevent overconfident data source registration. A source isn't "understood" just because it has a folder and four stub files. This protocol elicits what's actually needed before Claude can confidently query or cite it.

**Used by:** `/onboard` Phase 3 and `/document-update`'s new-data-source handler. Both invoke this protocol when a new source is being added.

---

## Principle: TBD beats guessing

For every field below, the answer must be one of:
- **Concrete** — PM provided or confirmed the value
- **TBD** — explicitly marked as unknown; Claude will ask when needed
- **N/A** — doesn't apply to this source (with a one-line reason)

NEVER silently guess a value. NEVER infer from the source name alone. "Trino" doesn't tell you what's in it.

---

## The Seven Questions

Ask adaptively. If the PM provided docs, extract from there and confirm. If not, ask them directly. Don't demand all seven at once — ask in small batches, let the PM answer.

### 1. Purpose and scope
> "What does this source answer? Give me one or two example questions you'd actually go to this source to answer."

Write this into `connection.md` under a "Purpose" heading. This is the most important — it's what stops "I'll just query it and see" guessing.

### 2. Connection mechanics
> "How do you connect? Endpoint / host? Auth method (keychain, SSO, service account, password)? Any network requirement like VPN or corp network? Do you have a working connection script or notebook?"

Write into `connection.md`. If PM has a working script, save it alongside.

### 3. Structure
> "What are the key tables / indices / streams? What does one row represent — an event, a transaction, a user-day aggregate? How is it partitioned (by date? by product?)?"

Write into `schema.md`. Table names + one-line descriptions of each + row grain + partition columns. Don't demand full column lists upfront — those fill in as queries get written.

### 4. Query dialect and quirks
> "What's the query language? Any dialect differences from standard SQL? Case-sensitivity of strings? Anything a newcomer gets wrong on their first query?"

Write into `gotchas.md` under a "Tool quirks" section.

### 5. Mandatory filters
> "Are there any filters I MUST always include to avoid wrong results? (e.g., excluding test data, partition filters, redis/cache flags)"

Write into `gotchas.md` under a "Mandatory filters" section. Most critical. Missing a mandatory filter silently returns wrong numbers — the most dangerous failure mode.

### 6. Join keys
> "How does this source join to your other data sources? What's the primary identifier for users / customers / orders here, and does it match your other sources?"

Write into `schema.md` under a "Join keys" section.

### 7. Freshness and lag
> "How fresh is the data? Real-time? 24-hour batch? Partition-level lag?"

Write into `connection.md` under a "Freshness" heading. Affects when analysis is valid.

---

## What to write when an answer is TBD

Instead of skipping or guessing, write explicitly:

```markdown
## Mandatory filters
TBD — PM will provide when first query against this source runs. (Not skipped; flagged for follow-up.)
```

This makes the gap visible. When a future query involves this source, Claude sees the TBD and must ask the PM before proceeding — not silently default.

---

## Confidence check before registering

At the end of the protocol, Claude MUST state openly what it knows and doesn't know. Example:

> "Registered <source-name>. Summary of what I captured:
>
> **Concretely known:**
> - Purpose: <one-line — what this source answers>
> - Connection: <how to connect — credential method + script if any>
> - Key tables / indices / streams (N): <list>
> - Freshness: <data lag>
>
> **TBD (I'll ask when relevant):**
> - <full schema of a key table>
> - <mandatory filters for a particular table>
> - <join keys across tables / sources>
> - <timezone of timestamp columns>
>
> Want to fill any of the TBDs now, or leave them until we actually query?"

This prevents the "I understood" overconfidence — what isn't known is visible.

---

## Adaptive protocol — don't be rigid

- If PM provided docs that answer questions 1-3, just confirm those and ask about 4-7
- If PM says "I don't know the schema yet, let me check with data team" — mark those fields TBD and move on
- If PM says "this source is going away in two months" — note it, ask if registering is still worth it
- If PM says "same structure as our other source X" — extract from X's folder and confirm

The goal isn't to slow onboarding down. The goal is to prevent silent "I've got it" when Claude actually hasn't.

---

## What this file is NOT

- Not a form to fill out mechanically
- Not a mandatory step if the PM already has comprehensive onboarding docs for the source (extract + confirm is enough)
- Not bureaucracy. Seven questions, five of which are two-line answers. Registration stays under 10 minutes for a typical source.

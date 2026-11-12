# Competitor Comparison

**Status:** Populated via `/onboard` (if PM has competitor data) or `/document-update` (as competitor observations emerge).

**Principle:** This file is factual, not interpretive. Describe what each competitor DOES and what we DO. Gaps, opportunities, and "what we should change" are interpretations — they belong in session logs, not here.

---

## Format

For each competitor flow:

### <Competitor Name> — <Flow Name>

**Screens:** `knowledge/competitors/<competitor-slug>/` (PNG files)

**Their flow:**
<factual description of their UX — steps, screens, behaviors. No evaluation.>

**Our flow:**
<factual description of our UX — steps, screens, behaviors. No evaluation.>

---

## Example (illustrative)

### Competitor A — Checkout Flow

**Screens:** `knowledge/competitors/competitor-a/checkout/`

**Their flow:**
Single-screen flow. User enters identifier; details fetch automatically; amount is prefilled and locked; one tap to confirm.

**Our flow:**
Three screens (landing → form → amount). Amount is editable even when prefilled. Back navigation loses state.

---

## What does NOT go here

- "They do this better than us" → interpretation, session log
- "Gap / opportunity" framings → session log, where the PM commits to investigating
- "We should copy X" → session log or decisions
- Anything with "better", "worse", "should" → not neutral, not knowledge
- **Their metrics or ours** — "they have 10M users" / "we convert at 5%". Numbers go stale and bias analysis. Qualitative descriptors ("market-leading scale", "enterprise focus") are OK. Specific numbers are not.

Keep the side-by-side. Let the reader draw conclusions in-session, not pre-drawn here.

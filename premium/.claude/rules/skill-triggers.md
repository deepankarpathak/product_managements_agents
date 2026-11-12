# Skill Auto-Triggers

When the PM's message matches any of these patterns, invoke the corresponding skill BEFORE doing any tool use or analysis. Skip this rule only if the PM typed a direct slash command (e.g. `/explore`) — Claude Code's command system handles those.

PREMIUM v1 has 7 skills: 5 main flow (`/onboard`, `/explore`, `/investigate`, `/decide`, `/ship`) and 2 utilities (`/discuss`, `/document-update`).

## /onboard
**Trigger phrases:** set up product, new product, onboard product, onboard a product, bootstrap, bootstrap product, setup product, create workspace, new analysis workspace, start product
**Examples that should trigger:** "set up a new product", "bootstrap the metro workspace", "onboard FASTag for me"

## /explore
**Trigger phrases:** analyze the funnel, analyze funnel, walk through funnel, walk me through the funnel, funnel analysis, conversion funnel, drop-off analysis, where are users dropping, what's happening with metric, what's happening with the metric, improve X, improve conversion, explore Y, explore the funnel, explore this cohort, screen analysis, cohort analysis, repeat users funnel, new users funnel, react users funnel, deep dive on this screen
**Examples that should trigger:** "let's walk through the repeat users funnel", "analyze the new user cohort", "what's happening with SBI conversion", "improve repeat users conversion"

## /investigate
**Trigger phrases:** why did X drop, why are X failing, why is X dropping, why do X abandon, investigate H-, investigate hypothesis, test the hypothesis that, find root cause of, root-cause, validate H-, validate hypothesis, test hypothesis, prove this, disprove this, dig into, deep dive on hypothesis, research hypothesis
**Examples that should trigger:** "why did repeat-user conversion drop in week 14?", "investigate H-002", "test the hypothesis that prefill is wrong", "find root cause of SBI failures", "validate H-004"

**Brief trigger:** `investigate brief`, `/investigate brief <id>`, `/investigate brief latest`, or a pasted markdown with `type: dashboard-brief` → run `/investigate` in Brief mode (see the command file).

## /decide
**Trigger phrases:** what should we do about, explore solutions for, options for fixing, options for, shortlist solutions, shortlist options, solution exploration, solutioning, what are our options, decide between, evaluate solutions
**Examples that should trigger:** "what should we do about prefill being wrong?", "explore solutions for SBI failures", "shortlist options for the bank-name fix"

## /ship
**Trigger phrases:** file a JIRA, file JIRA, create JIRA, create ticket, draft a JIRA, draft a ticket, write a ticket, push to JIRA, ship this, raise a ticket, JIRA ticket, write up the ticket
**Examples that should trigger:** "file a JIRA for the prefill fix", "draft a ticket for SBI escalation", "ship this finding"

## /discuss
**Trigger phrases (Lookup / Relate / Reflect):** quick question, remind me about, remind me what, what did we decide, show me, how is X connected, how is this connected, brainstorm, what if, should we, how should I, strategy, prioritize, let's discuss, let's think about, second opinion, sanity check, what's our SBI conversion, what's our X
**Trigger phrases (Pull — single-query data fetch):** pull the X, pull me the X, get me the X, give me the X for, what's the [metric] for [cohort] in [window], how many X in [window], how many X did we [verb] in [window], show me [data] for [cohort], fetch the X
**Examples that should trigger Lookup/Relate/Reflect:** "quick question — what's our SBI conversion?" (cached fact), "remind me about H-002", "what did we decide on prefill?", "show me the funnel-map link", "should we prioritize SBI or repeat users?"
**Examples that should trigger Pull:** "pull the new-user funnel for last week", "what's the SBI failure rate in March?", "how many recharges from Android in April?", "get me Cut B conversion for May 2026"
**NOT /discuss Pull (route to /explore):** "improve new-user conversion", "walk me through the funnel", "what's wrong with the FormPage" — fuzzy or multi-cut; not a single-question Pull.

## /document-update
**Trigger phrases:** save this, save this fact, update knowledge, update docs, add to docs, add to knowledge, remember this fact, persist this, persist findings, log this, save what we found, route to knowledge, end session, save session
**Examples that should trigger:** "save this — SBI uses BBPBFR003 as a success code", "update knowledge with the new error mapping", "remember this fact for later", "end session and persist findings"

## Routing rules
- If multiple skills could match, prefer the most specific one (`/investigate` > `/explore` > `/discuss`).
- **`/discuss` vs `/explore` — the bright line.** `/discuss` handles SPECIFIC measurable questions (one query, one answer) and lookups of cached facts. `/explore` handles GOALS, multi-cut walkthroughs, or anything that should produce hypotheses. Hard test: does the PM walk away with **one** number/table → `/discuss`; or do they walk away with **hypotheses + a segmented breakdown** → `/explore`?
  - Cached fact: "what's our SBI conversion?" (data is in INDEX) → `/discuss` Lookup
  - Fresh single query: "pull the new-user funnel for last week" (specific metric+cohort+window, one query) → `/discuss` Pull
  - Fuzzy goal or multi-cut: "improve new-user conversion", "walk me through the funnel", "deep dive on the SBI cohort" → `/explore`
  - "Why" question or specific theory: "why did SBI drop?", "test the prefill hypothesis" → `/investigate`
  - **If `/discuss` Pull starts to require a second query / segmentation, STOP and route to `/explore` per pivot-handling.md.** Pull is one-shot by definition.
- `/decide` runs AFTER `/investigate` has validated a problem. If the PM jumps to "what should we do" without a validated finding, ask whether to investigate first.
- `/ship` runs AFTER `/decide` (or after a validated `/investigate` if the PM skipped solutioning). It is JIRA-only for v1.
- If the PM's message is a continuation chip ("yes", "B", "go ahead", "next"), do NOT re-trigger a skill — continue the active flow.
- If no trigger phrase matches but the message implies analysis, defer to `.claude/rules/turn-classifier.md` for free-text classification.
- If the PM signals a different skill mid-flow, defer to `.claude/rules/pivot-handling.md`.
- Auto-trigger means: invoke the skill silently and run its Phase 0. Do not narrate "I'm invoking /explore because…" — just run it. DO open every response while a skill is active with the routing tag (see **Routing transparency** below). Tag is visible state; narration is noise.

## Routing transparency

Every response while a skill is active opens with a one-line tag indicating the active skill and phase. The PM should never have to guess what skill is running.

**Format:** `[/<skill> — Phase <N> <name>]`

**Examples:**
- `[/explore — Phase 1 Frame]`
- `[/explore — Phase 3 Segment]`
- `[/investigate — Phase 1 Frame · hypothesis mode]`
- `[/investigate — Phase 3 Test]`
- `[/decide — Phase 4 Persist]`
- `[/ship — Phase 2 Format]`
- `[/onboard — Phase 1 Greet]`
- `[/discuss — Lookup]` / `[/discuss — Relate]` / `[/discuss — Reflect]` / `[/discuss — Pull]` (utility skills, mode in place of phase)
- `[/document-update — Phase 2 Locate]`

**Pivot signals** (per `pivot-handling.md`):
- `[pivot: /investigate → /explore — gate]` while showing the park/abandon/finish prompt
- After the PM picks: resume tagging the new active skill normally (`[/explore — Phase 1 Frame]`)

**When NOT to tag:**
- Session Boot greeting (no skill active yet) — no tag
- Free-form conversation when no skill matched and the message doesn't warrant one — no tag, but if the response runs longer than 3 lines, prefer routing to `/discuss` so the tag IS present
- Continuation chips ("yes", "go ahead", "B") — same tag as the prior response (the active phase hasn't changed unless an exit gate cleared)

**The tag is mandatory whenever a skill is active.** Skipping it is a routing-transparency failure even if the response content is correct.

## Retired skill names (do not invoke)
The following skills existed in earlier versions and have been folded into the 7-skill set. If you see them referenced in old session logs or memory files, treat them as historical context only.
- `/analyze-funnel` → `/explore`
- `/data-analysis` → `/explore`
- `/analyze-hypothesis` → `/investigate`
- `/rca` → `/investigate`
- `/solution-exploration` → `/decide`
- `/create-jira` → `/ship`
- `/start-product` → `/onboard`
- `/update-funnel-map` → folded into `/explore` and `/document-update`
- `/measure` → folded into `/investigate` (validation phase)

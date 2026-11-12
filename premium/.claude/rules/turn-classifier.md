# Turn Classifier

This rule catches free-text PM input that does not match `.claude/rules/skill-triggers.md`. It runs on every PM turn AFTER Session Boot, BEFORE any tool use or analysis.

The router targets the 7-skill set: `/onboard`, `/explore`, `/investigate`, `/decide`, `/ship`, `/discuss`, `/document-update`.

## When to classify

**Classify** when the PM has just sent a free-text message that does not match a skill-trigger phrase.

**Skip classification** when:
- This is the PM's answer to the Session Boot greeting ("What are we working on today?") — that's already a structured branch
- The PM typed a direct slash command — Claude Code's command system handles these
- The PM sent a continuation token ("yes", "go", "next", "A", "B", a number) — continue the active flow
- A skill is already mid-execution — do NOT reclassify mid-skill (pivot signals are handled by `pivot-handling.md`)

## The 6 shapes

Silently classify into ONE of these. Do not narrate the classification.

| Shape | Pattern | Route to |
|---|---|---|
| **Question (lookup)** | direct ask about a fact already in the workspace. "What's our SBI conversion?", "What did we decide on prefill?", "Remind me about H-002." | `/discuss` |
| **Question (fresh)** | direct ask that requires new data or a structured walkthrough. "How is repeat-user conversion this month?", "Walk me through the new-user funnel." | `/explore` Phase 0.5 |
| **Hypothesis** | claim + implied cause. "Users drop because of X", "I think SBI is failing due to Y", "Why did week-14 conversion drop?" | `/investigate` Phase 0 |
| **Complaint** | observation, no question. "SBI conversion is bad", "Repeat users aren't converting" | `/explore` Phase 0.5 — first reframe as a question |
| **Solutioning** | asks what to do given a known problem. "What should we do about prefill?", "Options for fixing SBI?" | `/decide` (verify the finding is validated; if not, route to `/investigate` first) |
| **Off-skill** | measurement, parked work, multi-issue dump, knowledge persistence. "Did the fix work?", "Save this — SBI uses BBPBFR003 as success", "Three things…" | `/document-update` (for persistence), `/investigate` (for measurement of a shipped change), or propose the right skill. Do NOT dive in. |
| **Vague** | unscoped, broad. "Tell me about FASTag", "What's interesting?", "What should I look at?" | Run frame-establishment chips BEFORE any tool use |
| **Conversational** | brainstorm, strategy, opinion. "Should we…", "What if…", "How should I prioritize?" | `/discuss` |

(There are 8 rows above for clarity, but the canonical 6 shapes are: Question, Hypothesis, Complaint, Off-skill, Vague, Conversational. Question is split into lookup vs. fresh because they route to different skills.)

## Disambiguation rules

1. **Lookup vs. fresh data.** If the question can be answered from `funnel-map.md`, memory logs, or a recent investigation file, route to `/discuss`. Only route to `/explore` if the answer requires a new query or a structured funnel walkthrough.
   - "What's our SBI conversion?" → `/discuss` (look it up)
   - "Walk me through the SBI funnel for repeat users" → `/explore` (structured walkthrough)
   - "How is repeat-user conversion trending this month?" → `/explore` (fresh data)

2. **Solutioning without validation.** If the PM jumps to `/decide` without a validated problem, do not silently spin up solutioning. Ask: "Has this been investigated yet, or should we run `/investigate` first?"

3. **Hypothesis vs. Question.** If the input could plausibly be either (e.g. "are SBI users failing more?"), default to the lighter-weight skill. `/discuss` lookup beats `/explore` if the data already exists; `/explore` beats `/investigate` if the leak is not yet identified.

## How to behave after classifying

1. **Silent route.** Invoke the chosen skill's Phase 0. Do not say "I'm classifying this as a Hypothesis" or "Routing to /investigate."
2. **Confidence check.** If the input could plausibly be two shapes, default to the lighter-weight skill (`/discuss` over `/explore`, `/explore` over `/investigate`, `/investigate` over `/decide`). Better to under-commit than spin up a heavy investigation on ambiguous input.
3. **One-word resolution allowed.** If you genuinely cannot tell, ask ONE clarifying question and let the PM disambiguate. Do not classify-and-hope.

## Why this exists

Without classification, free-text input falls through to the model's default "be helpful" mode. The model then skips the structured skill flow, bypasses Session Boot state setup (CURRENT SESSION), skips skill-specific Phase 0 contracts, and produces analyst-mode output with no persistence target. This rule closes that gap.

Skills are not auto-invoked by Claude Code from free text — only from explicit slash commands or from this classifier routing them.

## Examples

| PM input | Shape | Route |
|---|---|---|
| "let's walk through repeat users conversion funnel" | Question (fresh, scoped) | `/explore` |
| "what's our SBI conversion right now?" | Question (lookup) | `/discuss` |
| "remind me what we decided on prefill" | Question (lookup) | `/discuss` |
| "I think SBI users fail because of bank-side timeouts" | Hypothesis | `/investigate` |
| "why did repeat-user conversion drop in week 14?" | Hypothesis | `/investigate` |
| "SBI conversion looks bad" | Complaint | `/explore` (reframe) |
| "what should we do about the wrong prefill?" | Solutioning | `/decide` (if H-validated) |
| "did the SBI alias fix actually work?" | Off-skill (measurement) | propose `/investigate` on the experiment |
| "save this — BBPBFR003 is a success code, not failure" | Off-skill (persistence) | `/document-update` |
| "tell me about repeat user conversion" | Vague | frame chips first |
| "should we do SBI first or prefill first?" | Conversational | `/discuss` |
| "yes" | continuation | continue active flow |
| "/explore" | direct command | skip classifier |

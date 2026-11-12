---
description: Take a validated problem foundation (confirmed hypothesis, investigation, or strong insight) and produce a shortlisted set of solutions — each grounded in the root cause or insight, evaluated against real constraints, and tagged with a falsifiable hypothesis. Foundation in → shortlist with confidence out.
---

# /decide — Foundation to shortlist

**Model:** Sonnet by default.

## When to run
- PM has a CONFIRMED hypothesis and wants solution options
- PM has completed `/investigate` and root cause is confirmed
- PM has completed `/explore` and an insight is strong enough to act on
- PM has a strong signal (incident, customer escalation, competitive move) and wants to explore solutions with guardrails

**Use `/explore` or `/investigate` first** if the problem is not yet defined or validated. This skill solves problems, it doesn't define them.

**Pre-check:** none. This skill works off prior outputs and PM input. No data queries.

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Establish foundation | PM confirmed solution target + foundation confidence (HIGH/MED/LOW) |
| 2 | Define constraints | PM confirmed hard/soft limits + timeline + TBDs |
| 3 | Generate options | PM confirmed full options list (under approved levers, prior-solution check done) |
| 4 | Evaluate & shortlist | PM approved tiered shortlist; report + hypothesis back-edits + INDEX + session all persisted |

---

## Phase 1 — Establish Foundation

**Goal:** confirmed solution target + explicit foundation confidence that travels through the skill.

**Steps:**
1. Ask PM: *"What's the basis for solutioning? A confirmed hypothesis, a prior investigation, an `/explore` insight, or a signal you're working from?"*
2. Once PM answers → `@schema-reader` reads the named source(s):
   - **Confirmed hypothesis cited** → read `artifacts/hypotheses/H-<id>.md`. Extract: hypothesis statement, signal, cohort, status, linked investigation/report. Foundation confidence = HIGH if status `CONFIRMED`, MEDIUM if `SUSPECTED`.
   - **Investigation cited** → read `artifacts/investigations/<file>.md`. Extract: problem, root cause, segment, impact, status. Foundation confidence = HIGH if `CONFIRMED`, MEDIUM if `SUSPECTED`.
   - **Explore report cited** → read `artifacts/reports/<file>.md`. Extract: problem, insight, segment, implication. Foundation confidence = MEDIUM (insight, root cause not necessarily confirmed).
   - **Both (investigation + explore)** → read both. Investigation for cause, explore for scale/segment. Foundation confidence = HIGH.
   - **Signal only (no prior skill output)** → ask PM to state: problem, who is affected, evidence, impact size. Document as-is — do not fill gaps by assumption. Foundation confidence = LOW. Tell PM: *"Foundation confidence is LOW. Solutions will be directional, not validated. Recommend `/explore` or `/investigate` first. Want to proceed anyway?"* If PM proceeds → continue with LOW labels on all outputs.
3. Convert the foundation into a one-sentence solution target: *"Reduce `<problem>` for `<segment>` caused by / indicated by `<root cause or insight>`."*
4. Confirm with PM: *"Solution target: `<target>`. Foundation confidence: `<HIGH/MEDIUM/LOW>`. Foundation artifact: `<H-ID or INV-ID or report path>`. Correct?"*

**Outputs:** nothing persisted yet.

**Exit gate:** PM confirmed solution target, foundation confidence, and foundation artifact reference.

---

## Phase 2 — Define Constraints

**Goal:** lock practical limits before generating options. Solutions that violate constraints are wasteful to evaluate.

**Steps:**
1. Ask PM: *"What constraints should we work within? Think: timeline (when ship), team (eng/design bandwidth), hard limits (cannot change — partner, compliance, architecture), soft limits (possible but slow or expensive)."*
2. PM states what they know. For anything unknown → mark `TBD` and flag: *"Effort and feasibility for `<area>` will need engineering input before finalising the shortlist."*
3. Document constraints:
   ```
   Hard limits:  <cannot be changed>
   Soft limits:  <possible but slow / costly>
   Timeline:     <when it needs to ship>
   TBD:          <items needing engineering input>
   ```
4. Confirm with PM: *"These are the constraints. Anything missing?"*

**Outputs:** constraints held in working state — persisted at Phase 4.

**Exit gate:** PM confirmed constraints.

---

## Phase 3 — Generate Options

**Goal:** valid solution levers first, then distinct options under those levers — informed by what's been tried before.

**Steps:**
1. **Identify levers.** Derive valid levers from the foundation:
   - **Root cause available (investigation or confirmed hypothesis)** → levers specific to the cause mechanism. *e.g. cause = gateway timeout → levers: retry logic, fallback gateway, partner escalation, pending-state UX.*
   - **Insight only (explore report)** → broader, symptom-based levers. *e.g. insight = Android new users drop at payment → levers: UX friction reduction, error messaging, payment method availability.*
   - **Signal only** → PM-driven. Suggest a broad list; PM narrows.
2. Present lever list to PM: *"Based on `<foundation>`, valid levers are: `<list>`. Remove any that aren't realistic given the constraints."* PM confirms or removes. Do not generate options for removed levers.
3. **Prior-solution check.** Before generating options → `@schema-reader` reads `artifacts/reports/` (filter: `report_type: decide`) and recent `sessions/` for past attempts on the same levers. For each confirmed lever, surface to PM: *"Lever `<X>` was explored before in `<file>`. Outcome: `<result>`."* PM decides whether the prior attempt rules out the lever, informs a variant, or is irrelevant.
4. **Generate options.** 2–4 distinct options per remaining valid lever. Each must address its lever directly, not duplicate other options, and stay within constraints. Format:
   ```
   Option:                       <one-sentence description>
   Lever:                        <which lever>
   Addresses root cause/symptom: <root cause | symptom | both>
   ```
5. **Reserve a "do nothing" option** in the list — explicitly: *"Do nothing / park: rationale = `<too small | too risky | wrong moment | blocked>`."* This is a real option, not a placeholder. It must be evaluated in Phase 4 alongside the others.
6. Ask PM: *"Any options to add or remove before we evaluate?"*

**Outputs:** options + lever list held in working state — persisted at Phase 4.

**Exit gate:** PM confirmed full options list (including "do nothing") under approved levers.

---

## Phase 4 — Evaluate & Shortlist

**Goal:** evaluate each option, shortlist into three tiers, attach a falsifiable hypothesis to each, persist with bidirectional links.

**Steps:**
1. **Evaluate.** For each option, present:
   ```
   Option:        <name>
   Impact:        <how much of the problem solved — root cause or symptom?>
   Effort:        <eng / design / ops — flag TBD if unknown>
   Risk:          <technical / UX / compliance / dependency>
   Time horizon:  Immediate mitigation | Short-term fix | Long-term fix
   ```
2. Flag any TBD effort/risk from Phase 2: *"Effort for `<option>` needs engineering input — marked TBD. Shortlisting as provisional until confirmed."*
3. Ask PM: *"Do any of these effort or risk estimates look wrong to you?"*
4. **Shortlist.** Select options that address the root cause or insight (not just symptoms — unless constraints make root-cause solutions impossible), fit constraints, and have meaningful impact relative to effort. Organise into three tiers:
   ```
   Immediate mitigation:  <option(s) shipping fast to reduce bleeding>
   Short-term fix:        <option(s) addressing cause within sprint cycles>
   Long-term fix:         <option(s) fully resolving the problem but taking longer>
   ```
5. **Attach a falsifiable hypothesis to each shortlisted option:**
   ```
   Hypothesis:    If we implement <option>, we expect <outcome> because <reasoning from root cause/insight>.
   Falsified by:  <data/signal that would tell us the hypothesis is wrong>
   ```
6. Confirm with PM: *"Here's the shortlist. Does this feel right? Any changes before we save?"*

**Outputs** (atomic, inline — Phase 4 doesn't terminate until ALL artifacts land):
- `@knowledge-updater` writes `artifacts/reports/<slug>-decide-YYYY-MM-DD.md` with frontmatter:
  ```
  ---
  report_type: decide
  solution_target: <one line>
  foundation: hypothesis | investigation | explore-report | signal | mixed
  foundation_artifact: <H-ID or INV-ID or report path or null>
  foundation_confidence: HIGH | MEDIUM | LOW
  session: <CURRENT_SESSION>
  ---
  ```
  Body: solution target, constraints, valid levers, prior-solution findings, full options list with evaluations, "do nothing" rationale, shortlist with hypotheses + falsifiers, TBD items.
- `@knowledge-updater` back-edits the foundation artifact (if `hypothesis` or `investigation`): add `solution_explored_in: artifacts/reports/<slug>-decide-YYYY-MM-DD.md` to its frontmatter. Skip back-edit when foundation is `signal` or `explore-report` only (no single hypothesis/investigation file to update).
- `@knowledge-updater` updates `artifacts/INDEX.md` typed registry: append a row to the **Reports** section (one for the decide report). Do NOT append to a generic row.
- `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md`: solution report created, decisions (levers confirmed, options evaluated, shortlist approved), open items (TBD effort/risk needing engineering input).

**Exit gate:** report + foundation back-edit (where applicable) + INDEX (Reports section) + session all written; PM has the next-step prompt.

**Next step prompt:**
- Shortlist includes an option to test → *"Want to design an experiment? Run `/ship` (experiment mode)."*
- Shortlist ready to execute → *"Want to file as JIRA? Run `/ship` (jira mode)."*

---

## Failure modes (named drift to avoid)

- Generating options before levers are confirmed — options outside valid levers are noise.
- Evaluating options without constraints locked — effort and impact are meaningless without them.
- Skipping the prior-solution check — reinventing failed fixes wastes effort.
- Forgetting "do nothing" as a reserved option — biases the skill toward action.
- Hypothesis without `Falsified by` — leaves no way to close the loop on whether the solution worked.
- Assuming feasibility for TBD items — flag visibly, never paper over.
- Padding the shortlist — 2–3 strong options beat 8 weak ones.
- Treating LOW foundation confidence as actionable — label all outputs as directional, recommend stronger foundation.
- Forgetting back-edit on foundation artifact — the hypothesis/investigation file must point forward to the decide report so future sessions see the chain.
- Appending to a generic INDEX row instead of the typed **Reports** section — breaks the typed registry contract.

## Out of scope

- Defining or investigating the problem → `/explore` or `/investigate`
- Designing experiments → `/ship` (experiment mode)
- Creating JIRA tickets → `/ship` (jira mode)

## Delegation

| Task | Agent |
|---|---|
| Load prior hypothesis / investigation / explore report / sessions | `@schema-reader` (Haiku) |
| Write decide report, foundation back-edit, INDEX (Reports section) append, session append | `@knowledge-updater` (Haiku) |
| Lever identification, option generation, evaluation, shortlisting | Main (Sonnet) |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `artifacts/reports/<slug>-decide-YYYY-MM-DD.md` | Create | Phase 4 |
| `artifacts/hypotheses/H-<id>.md` OR `artifacts/investigations/<file>.md` | Back-edit (`solution_explored_in:`) | Phase 4 (when foundation is hypothesis or investigation) |
| `artifacts/INDEX.md` (Reports section) | Append row | Phase 4 |
| `sessions/<CURRENT_SESSION>.md` | Append section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 4 |

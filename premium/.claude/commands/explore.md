---
description: Divergent discovery — PM brings a goal, funnel, metric, or open question; produce a structured set of testable hypotheses and descriptive insights. Goal in → hypotheses out.
---

# /explore — Divergent discovery

**Model:** Sonnet by default. Switch to Opus mid-session if hypothesis generation requires cross-source reasoning across 3+ data sources simultaneously.

## When to run
- PM has a goal ("improve new-user conversion") and wants candidates worth pursuing
- PM wants to walk a funnel cohort end-to-end and find leaks
- PM wants to understand what's happening with a metric over time/segments
- PM has a fuzzy question and wants structure

**Use `/investigate` instead** if PM has a specific theory to test or a confirmed metric drop to root-cause. This skill is divergent (find candidates); `/investigate` is convergent (validate truth).

**Pre-check:** if `knowledge/data-sources/INDEX.md` is empty or a stub → halt: *"No data sources configured. Run `/onboard` first."*

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Frame | PM confirmed mode + scope + cohort + window; vocabulary grounded |
| 2 | Measure | PM confirmed data is reliable; observation set in hand |
| 3 | Segment | PM confirmed key signals / leaks |
| 4 | Generate + persist | PM approved hypothesis list; all artifacts persisted with bidirectional links |

---

## Phase 1 — Frame

**Goal:** confirmed mode + scope + cohort + window, with PM's vocabulary grounded against project definitions.

**Steps:**
1. Detect mode from PM language. State it back: *"Looks like a `<funnel | metric | goal | open>` question. Correct?"* If wrong → re-detect.
   - **Funnel mode:** walk a defined journey (e.g. CLP → Form → Amount → Pay).
   - **Metric mode:** understand a specific metric (conversion, success rate, retention).
   - **Goal mode:** PM has a goal but no target metric yet (improve X, reduce Y).
   - **Open mode:** fuzzy. Sharpen to one of the above before proceeding.
2. Ask the mode-specific scoping question:
   - Funnel: *"Which funnel? Which cohort? What time window?"*
   - Metric: *"Which metric? Which cohort? What time window? What baseline?"*
   - Goal: *"What does success look like? Who are we improving this for? Over what window?"* — then sharpen into a measurable metric.

   **Stop here. Wait for PM's answer before any tool use. Do NOT call `@schema-reader`, do NOT run the prior-work check, do NOT advance to Step 3 until the PM has named the metric / cohort / window. Mode confirmation and scoping answers must come from the PM, not from inference, prior context, or session history. The prior-work check (Step 4) informs scoping; it does not replace it.**
3. Once PM responds → `@schema-reader` reads `knowledge/data-sources/INDEX.md` (locate sources for the metric/funnel) AND `knowledge/product-context.md` (ground PM's vocabulary — cohort definition, journey/screen names, segment terms — against project definitions).
4. **Prior-work check.** `@schema-reader` reads `artifacts/INDEX.md` for prior `/explore` reports matching this scope. If found, surface to PM: *"You ran `/explore` on this scope on `<date>` (report: `<file>`, hypotheses generated: `<list>`). Want to (a) build on it, (b) re-run fresh, or (c) read it and stop?"*
5. Restate parsed components: *"You said: `<problem>`. In our project: `<metric>` = `<technical mapping>`; `<cohort>` = `<product-context definition>`; window = `<inferred>`; sources = `<list>`. Confirm?"* If PM's mental definition mismatches → discuss and re-ground before proceeding.

**Outputs:** nothing persisted yet.

**Exit gate** (every box must be checked before advancing to Phase 2):
- [ ] mode confirmed by PM (not inferred)
- [ ] metric / success criteria stated by PM
- [ ] cohort granularity chosen by PM
- [ ] time window chosen by PM
- [ ] vocabulary grounded against `product-context.md` and confirmed by PM
- [ ] prior-work check completed; if found, PM picked (a) build / (b) re-run / (c) read-only

---

## Phase 2 — Measure

**Goal:** pull baseline data for the chosen scope; validate it's reliable.

**Steps:**
1. **Ground folder slugs first.** Before sending any file list to `@schema-reader`, read `knowledge/data-sources/INDEX.md` and copy the **exact** folder slugs from it (e.g. `trino/`, `olap/`, `pulse/`, `es/`). Do NOT write source folder names from memory or inference — folder names like `trino-validation/` or `trino-olap/` are hallucinations and will cause file-not-found errors. Then `@schema-reader` reads `knowledge/data-sources/<verified-slug>/queries.md` (adapt a proven query if one fits), `gotchas.md` (mandatory filters), `connection.md` (declared freshness cadence + runner script + access pattern — required for execution-mode gate below).
2. **Runner confirmation (once per source, per phase).** Before drafting/running the first query of this phase, state in one sentence:

   > *"Source: <X>. Runner: <path from `<source>/connection.md`>. Creds: <available locally / not local — needs PM>. Confirm and I'll run all queries in this phase against this source — or tell me to hand them off instead."*

   Wait for PM confirmation (`go` / `run` / `yes` / equivalent) before executing.

   **If runner is absent or creds unreachable:** say so explicitly and ask PM how to proceed (hand off SQL for PM to run, or skip this phase).

   **Subsequent queries in the same phase against the same source: auto-run.** Show each query before executing, but do NOT re-ask for confirmation. The PM can interrupt at any point.

   **If source changes mid-phase** (e.g., Phase 2 starts on Pulse, then needs Trino OLAP): re-confirm for the new source.
3. State full query plan to PM **before running**:
   - Tables and source
   - Filters (including mandatory filters from gotchas.md)
   - Cohort definition (from grounded Phase 1)
   - Date window
   - Aggregation logic
   - Mode-specific shape:
     - Funnel: stage-by-stage event counts + conversion rates
     - Metric: trend over window + reference period comparison
     - Goal: whichever metric proxies the goal
4. *"Here's what I'll run: `<plan>`. Confirm?"* → PM approves → run. **Per-run folder:** at first save, `mkdir -p artifacts/data/<report-slug>-explore-YYYY-MM-DD/` (folder name byte-matches the future report filename minus `.md`). Save each query's raw output as `<query-slug>.{json,csv}` inside that folder, with a sidecar `<query-slug>.md` carrying full provenance frontmatter (see schema below). All Phase 2 + Phase 3 data for this run lives in this single folder — no flat files at `artifacts/data/`.
5. Post-fetch validation. Flag if any of:
   - Unexpected nulls or missing values in key columns
   - Abnormal zeros or spikes (pipeline issues)
   - Incomplete time windows (partial day/week)
   - Freshness lag beyond declared cadence
6. Present: *"Data pulled. `<headline numbers>`. `<any flags>`. Does this look reliable?"* If PM flags concern → investigate before proceeding.

**Outputs** (atomic, inline):
- `@knowledge-updater` writes raw data file + sidecar MD inside `artifacts/data/<report-slug>-explore-YYYY-MM-DD/`. Sidecar frontmatter schema (mandatory):
  ```yaml
  ---
  data_file: <query-slug>.json   # filename only — sibling of this MD
  source: <Pulse | Trino | ES | …, multi-source allowed>
  cohort: <one line, matches Phase 1 grounded definition>
  query: <one-line query description, OR multi-line block for SQL>
  filters: <mandatory + cohort filters applied>
  date_range: YYYY-MM-DD to YYYY-MM-DD
  generated_by: /explore
  generated_in_session: sessions/<CURRENT_SESSION>.md
  script: <path to runner if applicable, e.g. knowledge/scripts/funnel-pull/<script>.py>
  referenced_by: []   # back-edited at Phase 4 with report + hypothesis IDs
  ---
  ```

**Exit gate:** PM confirmed data reliability.

---

## Phase 3 — Segment

**Goal:** walk dimensions, find variance, identify the strongest signals.

**Steps:**
1. `@schema-reader` reads `knowledge/data-sources/<source>/schema.md` (raw dimensions) AND `knowledge/product-context.md` (derived dimensions: cohorts, journey segments, personas).
2. Present combined dimension menu to PM. Note any derived dimensions requiring windowed/CTE queries (e.g. NRR classification needs prior-month lookback). PM picks where to start (do not suggest defaults).
3. For each cut: state query → PM approves → run → present segments ranked by metric value/conversion rate/delta vs baseline. Save each cut's data to the same `artifacts/data/` slug (append rows or sidecar updates).
4. Iterate. Take the highest-signal segments. Narrow further. Log every ruled-out dimension explicitly: *`[Dimension X] — no meaningful difference. Ruled out.`*
5. Stop when key signals are isolated OR PM signals enough.
6. Present: *"Key signals: `<list>`. Each accounts for `<X%>` of `<delta or total>`."*

**Outputs:** segmentation findings held in working state — persisted at Phase 4.

**Exit gate:** PM confirmed key signals.

---

## Phase 4 — Generate + persist

**Goal:** convert signals into testable hypotheses + descriptive insights, persist everything with bidirectional links.

**Steps:**
1. **Generate insights** (descriptive findings — *what* the data shows, no theories):
   ```
   Insight:  <data-backed statement>
   Source:   <data file + filters + date>
   Segment:  <cohort/segment>
   ```
   Each insight cites source. Insights are facts; they don't get their own file — they live in the report body.
2. **Generate 3–7 hypotheses** (testable theories — *why* the patterns exist). Each in this format:
   ```
   Hypothesis:       <one sentence — why is this happening>
   Signal:           <what in Phase 3 points to this>
   Cohort:           <from Phase 1>
   Evidence needed:  <specific query or data point to validate>
   Source:           <which data source(s) can test this>
   Falsified by:     <what would disprove this>
   ```
3. Present full list to PM: *"Here are `<N>` insights and `<M>` hypotheses worth testing. Anything to add, remove, or restate?"*
4. PM confirms or edits.

**Outputs** (atomic, inline — Phase 4 doesn't terminate until all land):
- `@knowledge-updater` writes one file per hypothesis at `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` with frontmatter:
  ```
  ---
  id: H-<slug>-YYYY-MM-DD
  status: UNTESTED
  product: <product>
  cohort: <cohort>
  generated_by: /explore
  generated_in_session: <session file>
  parent_report: artifacts/reports/<slug>-explore-YYYY-MM-DD.md
  related_hypotheses: [<other H-IDs from same session>]
  data_files: [<sidecar MD paths inside artifacts/data/<run-folder>/>]
  investigated_in: null          # set by /investigate when this hypothesis is tested
  solution_explored_in: null     # set by /decide when solution options are generated
  action: null                   # set by /ship — JIRA ticket ID
  falsified_by: <one line>
  re_test_of: null               # set if this hypothesis re-tests an earlier one (cite ID)
  folded_into: null              # set if this is folded into a broader hypothesis (cite ID)
  ---
  ```
  Body: hypothesis statement, signal, evidence-needed, source, status change log (initial UNTESTED row only).
- `@knowledge-updater` writes the report at `artifacts/reports/<slug>-explore-YYYY-MM-DD.md` with frontmatter:
  ```
  ---
  report_type: explore
  mode: funnel | metric | goal
  scope: <one line>
  cohort: <cohort>
  date_range: YYYY-MM-DD to YYYY-MM-DD
  data_files: [<sidecar MDs>]
  hypotheses_generated: [<all H-IDs from this run>]
  session: <CURRENT_SESSION>
  ---
  ```
  Body: framing, observations (cited), insights, segmentation findings, ruled-out dimensions, hypothesis list with IDs.
- `@knowledge-updater` back-edits each sidecar MD inside `artifacts/data/<report-slug>-explore-YYYY-MM-DD/` to populate `referenced_by:` with the report path + hypothesis IDs that cite it.
- `@knowledge-updater` updates `artifacts/INDEX.md` typed registry: append rows to **Hypotheses (open)** section (one per hypothesis) and **Reports** section (one for the explore report).
- `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md`: artifacts created (report + N hypotheses + data files), decisions (mode, cohort, window, key signals), open items (hypotheses to investigate next).

**Exit gate:** all hypothesis files + report + back-edits + INDEX + session written.

**Next step prompt:**
- *"You have `<N>` untested hypotheses. Want to investigate `<top one>`? Run `/investigate`."*
- Or, if an insight is strong enough to act on directly: *"Insight `<X>` looks actionable. Want to skip ahead to `/decide`?"*
- Or: *"Want to pause and revisit later? All hypotheses are saved with `UNTESTED` status — they'll surface on next session boot."*

---

## Failure modes (named drift to avoid)

- **Letting the prior-work check short-circuit Phase 1 scoping** — prior work informs Phase 1, it does not replace it. Steps 1–2 (mode confirmation + mode-specific scoping question) must complete with PM input *before* `@schema-reader` is called or the prior-work gate is shown. Collapsing Steps 1–4 into one move is the most common Phase 1 failure.
- **Drafting SQL without first stating the runner path and asking the PM to confirm.** Even if the runner is obvious, the first-query-of-phase confirmation is required. The confirmation turn is the only structural verification that the agent actually checked `connection.md` and that the runner works in this environment.
- **Re-asking for confirmation on every query within a phase.** Once confirmed for a source, subsequent queries against the same source auto-run. Re-confirmation is required only when the source changes mid-phase.
- **Fabricating a "no runner available" or "no direct query access" reason without quoting from `connection.md`.** If the agent declares the runner unavailable, it must explicitly say it checked `connection.md` and quote what was missing (or absent).
- Generating hypotheses without citing the Phase 3 signal that points to them — every hypothesis traces to a data point.
- Padding the hypothesis count — 3–7 strong ones beat 12 weak ones.
- Skipping insights — descriptive findings are as valuable as testable theories. Produce both.
- Suggesting default dimensions in Phase 3 — PM picks from schema + product-context.
- Running queries in Phase 2 without PM approval of the full plan.
- Not persisting hypothesis files at Phase 4 — every hypothesis must exist as a file before the skill terminates, even if PM doesn't pick one to investigate now.
- Forgetting back-edits — INDEX, sidecar MDs, and parent report all need cross-references at write time.
- Treating PM mid-phase redirect as permission to skip persist — confirm what's being deferred via the pivot gate, never silent.

## Out of scope

- Validating any generated hypothesis → `/investigate`
- Generating solution options → `/decide`
- Filing tickets → `/ship`
- Defining new data sources → `/onboard`
- Free-form Q&A or quick lookups → `/discuss`
- Persisting freeform knowledge that didn't come out of this run → `/document-update`

## Delegation

| Task | Agent |
|---|---|
| Read INDEX, schema, queries, gotchas, connection, product-context, prior reports | `@schema-reader` (Haiku) |
| Write hypothesis files, report, sidecar MDs, INDEX updates, back-edits, session | `@knowledge-updater` (Haiku) |
| Mode detection, segmentation reasoning, insight + hypothesis generation | Main (Sonnet) |
| Cross-source reasoning (3+ sources) | Switch to Opus mid-session |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` | Create (one per hypothesis) | Phase 4 |
| `artifacts/reports/<slug>-explore-YYYY-MM-DD.md` | Create | Phase 4 |
| `artifacts/data/<report-slug>-explore-YYYY-MM-DD/<query-slug>.{json,csv}` + sidecar `<query-slug>.md` | Create folder + files | Phase 2 (mkdir on first save; subsequent queries append to same folder through Phase 3) |
| `artifacts/INDEX.md` (Hypotheses + Reports sections) | Append rows | Phase 4 |
| `sessions/<CURRENT_SESSION>.md` | Append section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 4 |

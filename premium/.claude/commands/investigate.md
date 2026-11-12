---
description: Convergent investigation — PM brings a hypothesis to validate or a metric movement to explain; produce a confirmed root cause or a disproved theory, with bidirectional links to all artifacts. Hypothesis or signal in → confirmed cause out.
---

# /investigate — Convergent investigation

**Model:** Sonnet by default. Switch to Opus mid-session if hypothesis testing requires reasoning across 3+ data sources simultaneously.

## When to run
- PM has a specific hypothesis to test (hypothesis mode — e.g. "validate H-bank-confusion-clp-2026-05-07")
- PM has a metric drop and wants to find why (signal mode — e.g. "SBI conversion fell 15% last week, why?")
- PM wants to validate or disprove a theory before acting on it
- PM is resuming an `UNTESTED` or `SUSPECTED` hypothesis from a prior session

**Use `/explore` instead** if PM has a goal but no specific hypothesis or metric movement to investigate. `/explore` is divergent (find candidates); this skill is convergent (validate truth).

**Pre-check:** if `knowledge/data-sources/INDEX.md` is empty or a stub → halt: *"No data sources configured. Run `/onboard` first."*

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Frame | Mode detected + confirmed; foundation grounded (hypothesis loaded OR metric+cohort+window confirmed) |
| 2 | Locate | (Signal mode only.) PM confirmed narrowed segment. Skip in hypothesis mode. |
| 3 | Test | ≥1 hypothesis at `SUSPECTED`, `CONFIRMED`, or `DISPROVED` with queried evidence |
| 4 | Conclude + persist | PM approved conclusion; hypothesis files updated, investigation file (if conclusive) written, INDEX + back-edits + session all persisted |

---

## Phase 1 — Frame

**Goal:** detect mode, ground the foundation, confirm scope before any query.

**Steps:**
1. Detect mode from PM language. State it back: *"Looks like a `<hypothesis | signal>` investigation. Correct?"* If wrong → re-detect.
   - **Hypothesis mode:** PM cites a hypothesis ID (`H-<slug>-YYYY-MM-DD`) or restates a specific theory ("test whether bank logos confuse new users on CLP").
   - **Signal mode:** PM cites a metric movement without a specific theory ("conversion dropped 15% on SBI last week — why?").
2. **Hypothesis mode path:**
   - `@schema-reader` reads `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` (the file PM cited or matches by description). If multiple match → list them, PM picks.
   - Read the file's frontmatter (cohort, parent_report, related_hypotheses, data_files, falsified_by) and body (signal, evidence-needed, status change log).
   - If status is already `CONFIRMED` or `DISPROVED` → flag: *"This hypothesis is already `<status>`. Re-test with new data, or pick a different one?"* If re-test → create new hypothesis file at Phase 4 with `re_test_of: <prior ID>`.
   - `@schema-reader` reads `knowledge/product-context.md` to ground cohort / journey vocabulary against project definitions.
   - Restate: *"Investigating: `<hypothesis statement>`. Cohort: `<cohort>`. Falsified by: `<falsified_by line>`. Evidence needed per the file: `<list>`. Confirm?"*
   - **Skip Phase 2.** Proceed directly to Phase 3.
3. **Signal mode path:**
   - Ask: *"What metric? What cohort? What time window? What's the reference baseline?"*
   - `@schema-reader` reads `knowledge/data-sources/INDEX.md` (locate source for the metric) AND `knowledge/product-context.md` (ground cohort/journey vocabulary).
   - Restate parsed components: *"You said: `<problem>`. In our project: `<metric>` = `<technical mapping>`; `<cohort>` = `<product-context definition>`; window = `<inferred>`; reference = `<inferred>`. Confirm?"* If PM's mental definition mismatches → discuss and re-ground.
   - State: *"I'll pull baseline for `<scoped metric, cohort, window>` from `<source>` to verify the movement. Confirm?"* → PM approves → run.
   - Present current vs reference, abs + % delta, affected users/revenue if derivable. Ask: *"Anything change recently — deploy, experiment, campaign?"* (note response; may short-circuit to Phase 3).
   - PM checkpoint: *"Worth a full investigation, or close as non-issue?"* If non-issue → write CLOSED-NON-ISSUE investigation file at Phase 4 path and end.
4. **Refusal guard.** If in hypothesis mode and PM asks to generate new hypotheses → refuse: *"That's `/explore`'s job. Want me to switch, or stay here and test the existing one?"*

**Outputs:** nothing persisted yet (signal mode baseline data is held in working state until Phase 4).

**Exit gate:** mode confirmed; hypothesis file loaded (hypothesis mode) OR metric+cohort+window+source confirmed (signal mode).

---

## Brief mode (signal mode, dashboard brief as the foundation)

**Trigger:** PM says `/investigate brief <id>` / `brief latest`, or pastes a `dashboard-brief` markdown (frontmatter `type: dashboard-brief`).

- Load the brief from `artifacts/briefs/` (`latest` = newest file by name). If pasted, use the pasted text and note that the file was not read.
- **Phase 1 changes:** do NOT ask for metric / cohort / window / reference. Take them from the brief: metric = payer-bank SR, cohort = the brief's `scope` bank, window = `window_now`, reference = `window_base`. Restate in one line and ask for a single confirm. Still read `knowledge/data-sources/trino-dwh/gotchas.md` (mandatory filters) and `knowledge/product-context.md`.
- **Baseline check:** re-pull the bank's SR for both windows from `trino-dwh` and compare with the brief's numbers. If they disagree by more than the data-freshness lag explains, say so before going further.
- **Phase 2 (Locate):** the brief already segments by flow, handle and error code. Start from the brief's biggest contributor, then verify it with one cut; do not re-run every dimension.
- **Check existing notes first:** the brief lists dashboard notes for this scope (NPCI circulars, downtime). If one covers the window, test that explanation first.
- **Phase 3/4:** unchanged, with these additions: BD-heavy rises are customer-side, not bank faults (see `gotchas.md`); the verdict is one of CONFIRMED / DISPROVED / SUSPECTED / CLOSED-NON-ISSUE.
- **Phase 4 write-back (mandatory in brief mode):** after the PM approves the conclusion, post the verdict to the dashboard and set the brief's frontmatter `status:` to `INVESTIGATED` with `investigation: <INV id>`:

  ```bash
  curl -s -X POST http://localhost:5000/api/udash/annotations -H 'Content-Type: application/json' -d '{
    "kind":"investigation","date":"YYYY-MM-DD","scope":"<BANK>",
    "status":"CONFIRMED|DISPROVED|SUSPECTED|OPEN|CLOSED-NON-ISSUE",
    "confidence":"HIGH|MEDIUM|LOW","ticket":null,"briefId":"<brief id>",
    "label":"<one-line cause, max 120 chars>"}'
  ```
  `date` = first day of the affected window. If the dashboard backend is not running (connection refused), say so and give the PM the exact command to run later; do not retry in a loop.
- Persist the usual Phase 4 artifacts as well. The annotation is the dashboard-facing summary, the investigation file is the evidence.

---

## Phase 2 — Locate (signal mode only)

**Goal:** narrow the metric movement to a concrete segment that accounts for the bulk of the drop.

**Skip entirely in hypothesis mode** — the hypothesis already names its segment.

**Steps:**
1. `@schema-reader` reads `knowledge/data-sources/<source>/schema.md` (raw dimensions) AND `knowledge/product-context.md` (derived dimensions: cohorts, personas, journey segments).
2. **Broad cut.** Present combined dimension menu. PM picks one (do not suggest defaults). State source + filter + date window → PM approves → run → present segments ranked by impact delta. PM picks segment to drill into.
3. **Deep cut.** Iterate on the chosen segment. For each new dimension: state query → PM confirms → run. Log every ruled-out dimension explicitly: *`[Dimension X] — no meaningful difference. Ruled out.`*
4. Stop when a narrow segment isolates the bulk of the drop OR PM signals enough.
5. Present: *"Narrowed to: `<segment>`. Accounts for `<X%>` of total drop."*

**Outputs:** segmentation findings + raw data held in working state — persisted at Phase 4 (sidecar MDs written then).

**Exit gate:** PM confirmed narrowed segment.

---

## Phase 3 — Test

**Goal:** validate the hypothesis (hypothesis mode) OR generate root-cause hypotheses for the narrowed segment and test them (signal mode), each with queried evidence. Observation before interpretation.

**Steps:**
1. `@schema-reader` reads `knowledge/data-sources/<source>/queries.md` (adapt a proven query if one fits), `gotchas.md` (mandatory filters), `connection.md` (runner script + access pattern — required for execution-mode gate below), error mappings, prior investigation files for the same scope (if any). Only what's relevant.
2. **Runner confirmation (once per source, per phase).** Before drafting/running the first query of this phase, state in one sentence:

   > *"Source: <X>. Runner: <path from `<source>/connection.md`>. Creds: <available locally / not local — needs PM>. Confirm and I'll run all queries in this phase against this source — or tell me to hand them off instead."*

   Wait for PM confirmation (`go` / `run` / `yes` / equivalent) before executing.

   **If runner is absent or creds unreachable:** say so explicitly and ask PM how to proceed (hand off SQL for PM to run, or skip this phase).

   **Subsequent queries in the same phase against the same source: auto-run.** Show each query before executing, but do NOT re-ask for confirmation. The PM can interrupt at any point.

   **If source changes mid-phase** (e.g., Phase 2 starts on Pulse, then needs Trino OLAP): re-confirm for the new source.
3. **Hypothesis mode:** the hypothesis is already defined. Convert its `Evidence needed` line into a concrete query plan. Skip to step 5.
4. **Signal mode:** generate 3–5 root-cause hypotheses for the narrowed segment. Each in this format:
   ```
   Hypothesis:       <one sentence — why this segment is dropping>
   Segment:          <from Phase 2>
   Signal:           <what in Phase 2 points to this>
   Evidence needed:  <specific query or data point>
   Source:           <which data source>
   Falsified by:     <what would disprove this>
   Status:           UNTESTED
   ```
   PM picks order to test.
5. For each hypothesis: state full query plan (tables, filters, cohort, date, aggregation) → PM approves → run → present **observation first, interpretation second**. Update status:
   - `SUSPECTED` — single signal supports it, more evidence needed
   - `CONFIRMED` — 2+ independent sources or definitive single-source evidence
   - `DISPROVED` — evidence contradicts the hypothesis (log reason; never silently dropped)
6. **Per-run folder:** at first save, `mkdir -p artifacts/data/<investigation-slug>-investigate-YYYY-MM-DD/` (folder name byte-matches the future investigation filename minus `.md`). Save each query's raw output as `<query-slug>.{json,csv}` inside that folder. Sidecar MDs are created at Phase 4 with full provenance + referenced_by. All Phase 2/3 data for this investigation lives in this single folder — no flat files at `artifacts/data/`.
7. STOP after each result. PM decides continue or conclude.
8. If all tested are `DISPROVED` in signal mode → ask: *"Second round, revisit Phase 2 segment, or close as no clear cause?"* If hypothesis mode and the one hypothesis is `DISPROVED` → proceed to Phase 4 and write the disproved record.

**Outputs:** hypothesis statuses + raw data held in working state — persisted at Phase 4.

**Exit gate:** ≥1 hypothesis at `SUSPECTED`, `CONFIRMED`, or `DISPROVED` with queried evidence. Do not advance otherwise.

---

## Phase 4 — Conclude + persist

**Goal:** synthesize the conclusion, persist updates to the hypothesis file(s), write the investigation file (if conclusive), and back-edit every referenced artifact. Bidirectional links required.

**Steps:**
1. Synthesize from Phases 1–3 only — no new claims. Present:
   ```
   Conclusion:  <one sentence — root cause, or "disproved" with reason, or "open">
   Confidence:  HIGH | MEDIUM | LOW
   Evidence:    <bullets, each cites source + date + filters>
   Ruled out:   <bullets — DISPROVED hypotheses + why>
   Impact:      <users, volume/revenue delta, date range — if signal mode>
   ```
2. **Confidence rules:** HIGH = confirmed by 2+ independent sources. MEDIUM = single source, consistent with Phase 2 pattern. LOW = circumstantial only.
3. **LOW confidence handling:** do not present as a finding. Offer (a) more queries (suggest which), or (b) park hypothesis as `SUSPECTED` / investigation as `OPEN`. Do not write an investigation file claiming a root cause on LOW evidence.
4. **Decide artifact path:**
   - Conclusive (`CONFIRMED` or `DISPROVED` with sufficient evidence) → write investigation file.
   - Inconclusive (LOW confidence, PM parks) → skip investigation file. Hypothesis stays `SUSPECTED` (or returns to `UNTESTED` if PM rejects the query plan); decision logged in session.
5. PM approves conclusion.

**Outputs** (atomic, inline — Phase 4 doesn't terminate until ALL applicable artifacts land):
- `@knowledge-updater` writes sidecar MDs for each query's raw data inside `artifacts/data/<investigation-slug>-investigate-YYYY-MM-DD/<query-slug>.md`. Sidecar frontmatter schema (mandatory):
  ```yaml
  ---
  data_file: <query-slug>.json   # filename only — sibling of this MD
  source: <Pulse | Trino | ES | …, multi-source allowed>
  cohort: <one line, matches the hypothesis cohort>
  query: <one-line description, OR multi-line block for SQL>
  filters: <mandatory + cohort filters applied>
  date_range: YYYY-MM-DD to YYYY-MM-DD
  generated_by: /investigate
  generated_in_session: sessions/<CURRENT_SESSION>.md
  script: <path to runner if applicable>
  referenced_by: [<investigation file + hypothesis IDs that cite it>]
  ---
  ```
- `@knowledge-updater` updates each tested hypothesis file at `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md`:
  - frontmatter: set `status` to new value, set `investigated_in:` to the new investigation file (or null if inconclusive), set `falsified_by:` if newly disproved, set `folded_into:` if folded, set `re_test_of:` on a new file if re-testing.
  - body: append a status change log entry — date, prior status, new status, evidence summary (one paragraph), session reference.
- **If conclusive:** `@knowledge-updater` writes `artifacts/investigations/<slug>-rca-YYYY-MM-DD.md` with frontmatter:
  ```
  ---
  id: INV-<slug>-YYYY-MM-DD
  status: CONFIRMED | SUSPECTED | OPEN | CLOSED-NON-ISSUE
  mode: signal | hypothesis
  foundation: <metric+segment for signal mode, OR H-ID for hypothesis mode>
  hypotheses_tested: [<H-IDs>]
  data_files: [<sidecar MDs>]
  solution_explored_in: null
  session: <CURRENT_SESSION>
  confidence: HIGH | MEDIUM | LOW
  ---
  ```
  Body: framing, narrowed segment (if signal mode), all hypotheses tested with statuses + evidence, ruled-out list, impact, conclusion.
- **If re-testing a prior hypothesis:** `@knowledge-updater` creates a new hypothesis file with `re_test_of: <prior ID>` in frontmatter, AND back-edits the prior file's frontmatter to add `re_tested_in: <new ID>`.
- `@knowledge-updater` updates `artifacts/INDEX.md` typed registry:
  - **Investigations** section: append row for new investigation file (if written).
  - **Hypotheses (open)** / **Hypotheses (closed)** sections: move/update each tested hypothesis row to reflect its new status.
- `@knowledge-updater` back-edits every referenced sidecar MD's `referenced_by:` to include the investigation ID and updated hypothesis IDs.
- `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md`: artifacts created/updated, decisions (mode, narrowed segment, hypotheses tested, conclusion), open items (untested adjacent hypotheses, data gaps).

**Exit gate:** all applicable artifacts written + every back-edit landed; PM has the next-step prompt.

**Next step prompt:**
- `CONFIRMED` root cause → *"Want to explore solutions? Run `/decide`."*
- `DISPROVED` → *"Hypothesis disproved. Logged. Anything else to investigate?"*
- LOW confidence / parked → *"Insufficient evidence. Hypothesis stays `SUSPECTED`. Run more queries, or move on?"*
- Direct to ticket (rare — only if the conclusion is itself the ticket scope) → *"Want a JIRA? Run `/ship`."*

---

## Failure modes (named drift to avoid)

- **Drafting SQL without first stating the runner path and asking the PM to confirm.** Even if the runner is obvious, the first-query-of-phase confirmation is required. The confirmation turn is the only structural verification that the agent actually checked `connection.md` and that the runner works in this environment.
- **Re-asking for confirmation on every query within a phase.** Once confirmed for a source, subsequent queries against the same source auto-run. Re-confirmation is required only when the source changes mid-phase.
- **Fabricating a "no runner available" or "no direct query access" reason without quoting from `connection.md`.** If the agent declares the runner unavailable, it must explicitly say it checked `connection.md` and quote what was missing (or absent).
- Stating a root cause without queried evidence — never.
- Skipping Phase 2 in signal mode and jumping to hypothesis generation without segmenting — segment first, always.
- Silently dropping a `DISPROVED` hypothesis — append the reason to its status change log; never delete.
- Treating LOW confidence as actionable — refuse; suggest more queries or park.
- In hypothesis mode, generating new hypotheses — refuse and route to `/explore`.
- Forgetting to back-edit referenced artifacts at Phase 4 — INDEX, sidecar MDs, prior hypothesis files, parent reports all need bidirectional links.
- Creating a duplicate hypothesis file when re-testing instead of using `re_test_of:` linkage — keep history traceable.
- Treating PM mid-phase redirect as permission to skip persist — confirm what's being deferred via the pivot gate, never silent.

## Out of scope

- Generating new hypotheses → `/explore`
- Generating solution options → `/decide`
- Filing tickets → `/ship`
- Defining new data sources → `/onboard`
- Free-form Q&A or quick lookups → `/discuss`
- Persisting freeform knowledge that didn't come out of this run → `/document-update`

## Delegation

| Task | Agent |
|---|---|
| Read hypothesis file, INDEX, schema, queries, gotchas, error mappings, product-context, prior investigations | `@schema-reader` (Haiku) |
| Write investigation file, update hypothesis files, sidecar MDs, INDEX updates, back-edits, session | `@knowledge-updater` (Haiku) |
| Mode detection, segmentation, hypothesis testing, root-cause synthesis, interpretation | Main (Sonnet) |
| Cross-source reasoning (3+ sources) | Switch to Opus mid-session |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` | Update (status, investigated_in, status change log) | Phase 4 |
| `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` (new) | Create with `re_test_of:` | Phase 4 (re-test only) |
| `artifacts/investigations/<slug>-rca-YYYY-MM-DD.md` | Create | Phase 4 (conclusive only) |
| `artifacts/data/<investigation-slug>-investigate-YYYY-MM-DD/<query-slug>.{json,csv}` + sidecar `<query-slug>.md` | Create folder + files | Phase 2/3 (data, mkdir on first save) + Phase 4 (sidecars) |
| `artifacts/INDEX.md` (Investigations + Hypotheses sections) | Append/update rows | Phase 4 |
| `sessions/<CURRENT_SESSION>.md` | Append section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 4 |

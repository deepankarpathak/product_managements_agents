---
description: Quick PM queries that don't justify a full skill — lookup, relate, reflect across existing artifacts, or pull a single specific data point. Lightweight; one question in, one answer out.
---

# /discuss — Quick lookups, relations, reflections, and pulls

**Model:** Sonnet by default. Switch to Opus mid-session if a Reflect-type question forces synthesis across 3+ investigations or reports simultaneously.

## When to run
- PM has a quick lookup ("what did we decide on March 12?", "show me open hypotheses")
- PM wants to understand connections between past artifacts ("how is H-001 connected to the SBI investigation?", "which JIRAs came out of prefill RCA?")
- PM wants synthesis across recent work ("what's the most important thing we learned this month?", "should we keep investigating SBI?")
- PM wants ONE specific number or table from ONE query, with no analysis ("pull the new-user funnel for last week", "what's the SBI failure rate in March?", "how many recharges from Android in April?")

**Hard disambiguation — don't confuse this with `/explore`:**

| Signal | Skill |
|---|---|
| PM walks away with **one** number / table from one query | `/discuss` Pull |
| PM walks away with hypotheses, a segmented breakdown, or a structured walkthrough | `/explore` |
| PM has a hypothesis to test or a "why X dropped" question | `/investigate` |
| Answer already exists on disk (cached fact, prior report, INDEX entry) | `/discuss` Lookup |

**Bright lines for Pull:**
- Metric, cohort, and time window are **all named or trivially specifiable** (no fuzzy goal like "improve X")
- The PM's question terminates in a single answer, not a funnel walk or comparison across multiple cuts
- Output is one query result; no hypothesis generation, no segmentation iteration, no report
- If PM follows up with "now slice by bank and platform and time of day" → that's `/explore`. STOP and route.

**Use `/investigate` instead** if PM has a specific theory to test or a confirmed metric drop to root-cause. **Use `/explore` instead** if PM wants to generate hypotheses, walk a funnel, or run multiple cuts to find variance.

**Pre-check:** for Pull mode, `knowledge/data-sources/INDEX.md` must exist (otherwise route to `/onboard`). Lookup/Relate/Reflect modes work off whatever state already exists.

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Classify | Question typed as lookup / relate / reflect / pull / out-of-scope |
| 2 | Read or Pull | Targeted reads (lookup/relate/reflect) OR single query run (pull) — answer material in hand |
| 3 | Answer | PM has direct answer with source/date cited (and confidence flagged for Reflect) |
| 4 | Optional handoff + log + persist (pull only) | Session log appended; for Pull, data + sidecar persisted atomically |

---

## Phase 1 — Classify

**Goal:** type the question into one of four buckets before reading anything.

**Steps:**
1. Read PM's question. Match against bucket signals:
   - **Lookup** — single fact, decision, or status that already exists on disk. Triggers: *"what did we decide…", "show me…", "when did…", "which…"*. Answer lives in one file. **Lookup-first rule:** if the answer might be cached, try Lookup before Pull. Read INDEX + recent sessions; only fall through to Pull if the data isn't there.
   - **Relate** — connection between artifacts. Triggers: *"how is X connected to Y", "remind me about H-002", "which JIRAs came out of…", "what's the trail on…"*. Answer requires traversing the frontmatter graph.
   - **Reflect** — synthesis across multiple recent artifacts. Triggers: *"what's the most important thing we learned…", "should we keep investigating…", "what's the pattern across…"*. Answer requires reasoning across 3+ files.
   - **Pull** — specific measurable question requiring a fresh single query. Triggers: *"pull the X for Y", "what's the [metric] for [cohort] in [window]", "get me the X by Y", "how many X in [window]"*. Must satisfy ALL: metric named, cohort implied/named, window implied/named, output is ONE number or table. **Reject Pull and route to `/explore` if:** PM's question is fuzzy ("improve X", "what's wrong with Y"), requires multiple cuts to answer, or PM expects hypotheses out.
   - **Out-of-scope** — question is actually structured analysis (*"why did SBI drop?"*, *"is the prefill fix working?"*, *"generate hypotheses for the form page"*, *"walk me through the funnel"*). State clearly and route: *"That's an analysis question. Run `/investigate` (specific theory) or `/explore` (fuzzy goal / multi-cut walkthrough)."* End the skill — do not run analysis inline.
2. State the bucket back to PM only if ambiguous: *"Reading this as a `<lookup | relate | reflect | pull>` question. Correct?"* If clear, skip this confirmation. **For Pull specifically:** restate the parsed metric / cohort / window so PM can correct any misread before query execution: *"You want `<metric>` for `<cohort>` over `<window>`. Confirm?"*
3. If out-of-scope → end skill with the routing message. No reads. No log unless the conversation already produced PM context worth capturing (then append to session log + exit).

**Outputs:** nothing persisted yet.

**Exit gate:** question typed (or skill ended via out-of-scope route).

---

## Phase 2 — Read

**Goal:** load only what's needed to answer the question. Targeted, not exhaustive.

**Steps (per bucket):**

1. **Lookup:**
   - `@schema-reader` reads the most recent 1–3 session files in `sessions/` (decisions, PM context, JIRA log).
   - If question references a specific artifact (a hypothesis ID, a report name, a JIRA ID) → also read that file directly.
   - If question references a metric or data point → `@schema-reader` reads `artifacts/INDEX.md` to locate the report that holds it, then reads that report.

2. **Relate (frontmatter graph traversal — the prime use case):**
   - Start from the file the PM named (e.g. `H-002`).
   - `@schema-reader` reads its frontmatter, extracts: `parent_report`, `data_files`, `investigated_in`, `action`, `related_hypotheses`.
   - Follow each link. For the linked investigation: extract its `solution` and `jira_ticket` fields. For the linked report: extract its `hypotheses_generated` siblings.
   - Continue until the graph is fully expanded for the PM's question. Stop at JIRA / solution leaves.
   - Result: holistic view of every artifact connected to the starting node.

3. **Reflect:**
   - `@schema-reader` reads the last 5–10 sessions in `sessions/` (sorted desc).
   - `@schema-reader` reads `artifacts/INDEX.md` Hypotheses (open) section + Reports section (titles + status only, not bodies).
   - `@schema-reader` reads recent investigation files referenced in those sessions.
   - Hold all of it as input for Phase 3 synthesis.

4. **Pull (single-query, fresh data):**
   - **Ground folder slugs first.** `@schema-reader` reads `knowledge/data-sources/INDEX.md` to get the exact source folder slugs (e.g. `pulse/`, `trino/`, `olap/`). Do NOT write source folder names from memory.
   - `@schema-reader` reads `knowledge/data-sources/<verified-slug>/queries.md` (find a proven query if one fits) + `gotchas.md` (mandatory filters) + `connection.md` (freshness cadence).
   - State the full query plan to PM: tables + source, filters (incl. mandatory), cohort, window, aggregation. *"Here's what I'll run: `<plan>`. Confirm?"*
   - PM approves → run **exactly one query**. If results require a follow-up cut, STOP and route: *"That needs a second query — this is now `/explore` territory. Want to switch?"* Pull is one-shot by definition.
   - **Save data + sidecar atomically.** `mkdir -p artifacts/data/<question-slug>-discuss-YYYY-MM-DD/` (folder name = a short slug describing the question, e.g. `sbi-failure-rate-march-discuss-2026-05-08`). Write the raw output as `<query-slug>.{json,csv}` and the sidecar `<query-slug>.md` with the same provenance frontmatter schema as `/explore` Phase 2 (data_file, source, cohort, query, filters, date_range, generated_by: /discuss, generated_in_session, script if applicable, referenced_by: []).
   - Hold the result for Phase 3 presentation.

**Outputs:**
- Lookup / Relate / Reflect: working state only — files read, content held for Phase 3.
- Pull: data file + sidecar persisted at write time (atomic, inline) inside `artifacts/data/<question-slug>-discuss-YYYY-MM-DD/`.

**Exit gate:** all relevant sources loaded (Lookup/Relate/Reflect) OR query executed and data + sidecar on disk (Pull).

---

## Phase 3 — Answer

**Goal:** direct answer to the PM, citing source, with confidence flagged when synthesizing.

**Steps:**
1. **Lookup:** state the fact. Cite the file + date. One line or one short paragraph. No methodology preamble.
   - Format: *"`<answer>`. Source: `<file path>`, dated `<date>`."*
2. **Relate:** present the holistic view, not a bare name. Show the chain: hypothesis → report → investigation → solution → JIRA, with each node cited.
   - Format:
     ```
     H-002 (UNTESTED → SUSPECTED) — Source: artifacts/hypotheses/H-002-...md
     Generated by: <report file>
     Investigated in: <investigation file> — finding: <one line>
     Action: <solution file or null>
     JIRA: <ticket ID or null>
     Related siblings: H-003, H-004
     ```
   - If a node in the chain is missing (e.g. no investigation yet, no JIRA), state that explicitly.
3. **Reflect:** synthesize. State the position clearly. Flag confidence: HIGH (multiple sources align), MEDIUM (consistent with one strong source), LOW (circumstantial — say so).
   - Format: *"`<position>`. Confidence: `<level>`. Evidence: `<bullets, each citing source + date>`. What I'm not sure about: `<gaps>`."*
   - Never present LOW confidence as a finding. Offer: *"Want me to investigate this properly? Run `/investigate`."*
4. **Pull:** present the number/table directly with full provenance. No interpretation, no theory, no "this might mean X" — just the data and where it came from.
   - Format: *"`<answer>`. Source: `artifacts/data/<question-slug>-discuss-YYYY-MM-DD/<query>.md`, ran `<date>`. Cohort: `<cohort>`. Window: `<window>`."*
   - If PM asks "why is it that number" or wants segmentation → that's `/explore` or `/investigate`. Offer the handoff in Phase 4, don't extend Pull.
5. PM may push back, ask follow-up, or accept. Iterate within Phase 3 if PM has additional questions on the same topic — don't restart classification unless the topic shifts. **For Pull: a follow-up that requires a different cut is a NEW Pull (or `/explore` if multi-cut), not an extension of the current one.**

**Outputs:** answer delivered inline. Nothing persisted yet.

**Exit gate:** PM has a direct answer (and confidence flagged for Reflect).

---

## Phase 4 — Optional handoff + log

**Goal:** capture the Q&A in the session log, offer a handoff if the question revealed work worth doing.

**Steps:**
1. **Optional handoff.** If the question revealed an open thread worth pursuing (an untested hypothesis surfaced, a pattern needs investigating, a parked decision needs revisiting), offer it once:
   - *"This surfaces `<thread>`. Want to explore it? Run `/explore`."* OR *"Want to investigate it? Run `/investigate`."*
   - One offer. No forced handoff. PM can ignore.
2. **Atomic persist (always runs).**

**Outputs** (atomic, inline — Phase 4 doesn't terminate until the write lands):
- `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md`: a brief Q&A entry under a **Discuss** subsection (PM question + one-line answer + sources cited). If PM provided new context during the discuss (verbal facts not in any file) OR a decision was made (park, prioritize, kill an idea), capture that under the same subsection. Do not paste the full answer body — keep it scannable.
- **For Pull only:** `@knowledge-updater` appends a row to `artifacts/INDEX.md` under **Data files** (slug, source, date pulled, referenced_by points to the session). The data file + sidecar were already written in Phase 2; this is the registry update. The session log Q&A entry must include the path to the saved data folder so the answer is reproducible.

**Exit gate:** session log appended; for Pull, INDEX.md Data files row also appended and data + sidecar verified on disk.

---

## Failure modes (named drift to avoid)

- **Pull mode running multiple queries** — Pull is exactly ONE query for ONE answer. If PM follows up with "now slice by bank / platform / time", STOP and route to `/explore`. Don't quietly chain queries — that's how `/discuss` becomes `/explore` with extra steps.
- **Pull mode skipping the data + sidecar persist** — every Pull writes to `artifacts/data/<question-slug>-discuss-YYYY-MM-DD/` so the answer is reproducible later. A Pull that returns a number without saving provenance is a failed Pull.
- **Pull mode pulling fuzzy questions** — if metric / cohort / window aren't all named, it's not a Pull. Either sharpen the question or route to `/explore`.
- **Lookup answering from memory when the data isn't on disk** — Lookup must cite a file. If you can't find the answer in INDEX or recent sessions, fall through to Pull (run the query) or route to `/explore`. Do NOT fabricate.
- **Pull mode generating hypotheses or insights** — Pull presents the data, full stop. No "this might mean…" interpretation. If interpretation is needed, that's `/explore` or `/investigate`.
- Creating files in `artifacts/hypotheses/`, `artifacts/reports/`, `artifacts/investigations/` — never. /discuss only writes to `artifacts/data/` (Pull) and `sessions/`.
- Returning bare facts without citing source/date — every answer cites where it came from.
- Synthesizing in Reflect mode without flagging confidence — HIGH/MEDIUM/LOW must be stated.
- Missing the holistic view in Relate mode — when PM asks about H-002, traverse all linked artifacts (report, investigation, solution, JIRA), not just return the hypothesis name.
- Skipping the session log append — every /discuss run gets a brief Q&A entry, even one-line lookups.
- Forcing a handoff — offer once if relevant, then drop it. PM is in charge.
- Treating an out-of-scope question as in-scope — if it's analysis, route. Don't half-do it.

## Out of scope

- Generating hypotheses → `/explore`
- Multi-cut walkthroughs / segmentation iteration / hypothesis generation from data → `/explore`
- Validating hypotheses → `/investigate`
- "Why" questions about a metric drop → `/investigate`
- Generating solution options → `/decide`
- Filing tickets → `/ship`
- Persisting freeform discoveries → `/document-update`
- Defining new data sources → `/onboard`
- Creating files in `artifacts/hypotheses/`, `artifacts/reports/`, `artifacts/investigations/` — out of scope. /discuss writes only to `artifacts/data/` (Pull only) and `sessions/`.

## Delegation

| Task | Agent |
|---|---|
| Read sessions, INDEX, frontmatter graph (multiple file reads) | `@schema-reader` (Haiku) |
| Read data-source schema/queries/gotchas for Pull | `@schema-reader` (Haiku) |
| Append session log; write data + sidecar (Pull); update INDEX (Pull) | `@knowledge-updater` (Haiku) |
| Classification, relation traversal logic, Reflect synthesis, Pull query plan | Main (Sonnet) |
| Cross-source synthesis (3+ reports/investigations) for Reflect | Switch to Opus mid-session |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `sessions/<CURRENT_SESSION>.md` | Append Q&A entry (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 4 (always) |
| `artifacts/data/<question-slug>-discuss-YYYY-MM-DD/<query>.{json,csv}` + sidecar `<query>.md` | Create folder + files | Phase 2 (Pull mode only) |
| `artifacts/INDEX.md` Data files row | Append | Phase 4 (Pull mode only) |

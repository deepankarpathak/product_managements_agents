---
description: Bootstrap a new product workspace — gather product context, register data sources, capture screens/competitors, and write the knowledge tree the rest of the skill set depends on. Empty workspace in → working knowledge base out.
---

# /onboard — Product workspace bootstrap

**Model:** Sonnet. No Opus needed — this skill is conversational drafting, not multi-source reasoning.

## When to run
- Brand-new product: no `knowledge/product-context.md` (or template stub only) and no entries in `knowledge/data-sources/INDEX.md`
- Adding a new data source to an already-onboarded product (partial onboarding — Phase 3 only)
- Updating product context after a major shift (cohort definition change, journey rename, business model pivot)

**Use `/explore` or `/investigate` instead** once knowledge is in place. This skill only writes to `knowledge/` and `CLAUDE.md` — it never runs analysis, generates hypotheses, or files tickets.

**Pre-check (opposite of other skills):** `@schema-reader` reads `knowledge/product-context.md` and `knowledge/data-sources/INDEX.md`. If product-context already has substantive content (not template-only) AND INDEX has ≥1 source row → halt: *"Looks like this product is already onboarded. Want to (a) add a new data source, (b) update product context, (c) capture screens/competitors, or (d) cancel?"* Route to the matching phase. Do NOT overwrite existing content silently.

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Greet + collect | PM described product, users, business goals, current pain points |
| 2 | Build product context | `knowledge/product-context.md` written and PM-approved |
| 3 | Register data sources | ≥1 source registered with connection.md + schema.md + gotchas.md + queries.md stub; INDEX.md updated |
| 4 | Capture screens + competitors (optional) | Screens/competitor files saved OR PM explicitly deferred |
| 5 | Wrap | `CLAUDE.md` skeleton + session log all written |

---

## Phase 1 — Greet + collect

**Goal:** PM has shared enough about their product to draft a real product-context, not a template echo.

**Steps:**
1. Open conversationally. Do NOT dump a checklist. Example opener:
   > *"Welcome. Before I write anything, I want to actually understand your product. A few things one at a time — not a survey. Each answer shapes how every later skill (`/explore`, `/investigate`, `/decide`, `/ship`) reads your data."*
2. Ask one question at a time, grounding each with why it matters. Wait for the answer before moving on:
   - *"What does the product do, and who's the user? — anchors every analysis I run."*
   - *"How does it make money? — so I know what 'success' means to your team."*
   - *"What user cohorts do you care about — new, repeat, reactivated, others? Any windowed rules (e.g. 'repeat = txn in last 30 days')? — these get hard-coded into every funnel query."*
   - *"Walk me through the user journey — named screens or stages in order? — I'll wire this to your event data later."*
   - *"What KPIs is the product measured on? — these become the metrics `/explore` runs against."*
   - *"What's currently hurting — suspicions, vague drops? — this won't go into product-context (knowledge stays neutral) but I'll log it as session context."*
3. Park pain points / hypotheses for the session log (Phase 5). Knowledge files stay neutral and reusable.
4. If PM has docs (PRD, research, Notion exports), ask: *"Got any docs I can read instead of asking everything? I'll pull what's useful and only ask for gaps."* Save originals to `knowledge/reference/` if shared.

**Outputs:** nothing persisted yet — context held in working state.

**Exit gate:** PM has answered all six anchor questions (or declined a specific one explicitly).

---

## Phase 2 — Build product context

**Goal:** `knowledge/product-context.md` exists, ≤200 lines, PM-approved.

**Steps:**
1. Draft `knowledge/product-context.md` with these sections (and only these — deeper detail belongs in domain-specific knowledge files):
   - **Product description** — what it does, who for, business model
   - **User cohorts** — definitions: new / repeat / react / others, with windowed/derived rules (e.g. NRR base-month classification) where applicable
   - **Journey stages** — named screens / flows in order
   - **Personas** — archetypes if relevant; skip if PM doesn't think in personas
   - **Business goals + KPIs** — what the product is measured on
   - **Current state / pain points** — high-level only, factual; opinion-flavored items go to session log
   - **Vocabulary glossary** — product-specific terms (e.g. "VRN", "BBPS", "react cohort") and what they mean
2. Show draft to PM: *"Here's the product-context I'd save. Read through — anything wrong, anything missing, anything I misframed?"*
3. Iterate until PM approves.
4. Hard limit: 200 lines. If draft exceeds, push detail into a sibling knowledge file (`knowledge/glossary.md`, `knowledge/personas.md`) and reference from product-context.

**Outputs** (atomic, inline):
- `@knowledge-updater` writes `knowledge/product-context.md`.

**Exit gate:** file written; PM approved content.

---

## Phase 3 — Register data sources

**Goal:** every source the PM names exists as a registered folder with the four canonical files; INDEX.md routes to them.

**Steps:**
1. Ask: *"What data sources do you have access to? Query engines (Trino, BigQuery, Snowflake), event tracking (Pulse, Mixpanel, GA), logs (Elasticsearch, Kibana), support tickets, anything else."*
2. For each source PM names, walk through registration one source at a time. Do NOT batch.
3. For each source, ask the four anchor questions:
   - **Connection:** *"How do I connect — endpoint, credentials, freshness cadence (real-time / daily partition / weekly batch)?"*
   - **Schema:** *"What tables / indexes / event types matter? Key columns, partition columns, dimensions worth segmenting on?"*
   - **Gotchas:** *"Mandatory filters I must always include? Type quirks? Joins that look right but aren't?"*
   - **Role:** *"What kind of question does this source answer best — funnel events, transaction outcomes, error logs, qualitative complaints?"*
4. Mark anything PM doesn't know as `TBD` — explicitly flagged, not omitted. Future skills will surface TBDs and prompt to fill.
5. Per source, `@knowledge-updater` creates `knowledge/data-sources/<source>/` folder with:
   - `connection.md` — connection details, freshness, ownership
   - `schema.md` — tables, key columns, dimensions, partition rules
   - `gotchas.md` — mandatory filters, type quirks, traps
   - `queries.md` — empty stub with header *"Proven queries (populated by `/explore` and `/investigate`)"*
6. `@knowledge-updater` appends a row to `knowledge/data-sources/INDEX.md`:
   ```
   | Source | Role | Connection | Registered |
   |---|---|---|---|
   | <name> | <one-line role> | data-sources/<source>/connection.md | YYYY-MM-DD |
   ```
7. Confidence check after each source: *"For `<source>` I have `<known fields>`; TBD: `<gaps>`. OK to register, or want to fill gaps now?"*

**Outputs** (atomic, inline — Phase 3 doesn't terminate until INDEX has ≥1 row):
- One folder per source with four files.
- INDEX row per source.

**Exit gate:** ≥1 source fully registered; INDEX.md has ≥1 typed row.

---

## Phase 4 — Capture screens + competitors (optional)

**Goal:** screen and competitor visuals organized OR explicitly deferred.

**Steps:**
1. Ask: *"Got screenshots of your user journey? Drop them in — I'll place them under `knowledge/screens/<cohort-or-flow>/`. If you'd rather do this later, totally fine — `/explore` will still run, just less grounded."*
2. If PM shares screens: rename to meaningful filenames (`landing.png`, `amount-entry.png`, `error-state.png`), place under `knowledge/screens/<flow>/`.
3. Ask: *"Any competitors worth comparing against? Screenshots of their equivalent flows are gold."*
4. If PM shares competitor material: create `knowledge/competitors/<competitor>/` per competitor with screens + a one-paragraph description in `knowledge/competitors/comparison.md`.
5. If PM defers either: log in session log under "Open" — *"screens deferred"*, *"competitors deferred"*. Do NOT block onboarding.

**Outputs:**
- `knowledge/screens/<flow>/*.png` — created files OR skipped with note.
- `knowledge/competitors/<competitor>/*` + `knowledge/competitors/comparison.md` — created OR skipped.

**Exit gate:** screens and competitors either captured OR explicitly deferred (logged for Phase 5 session entry).

---

## Phase 5 — Wrap

**Goal:** product-specific `CLAUDE.md` skeleton exists; session log appends the onboarding decisions; PM gets handoff prompt.

**Steps:**
1. `@knowledge-updater` writes `CLAUDE.md` skeleton at the product root: product name + one-line description, pointers to `knowledge/product-context.md` and `knowledge/data-sources/INDEX.md`, skill list (`/onboard`, `/explore`, `/investigate`, `/decide`, `/ship`, `/discuss`, `/document-update`), note that session boot auto-reads recent files in `sessions/`.
2. `@knowledge-updater` writes first session log `sessions/YYYY-MM-DD-onboarding.md` with frontmatter (`skill: /onboard`, `product: <product>`) and sections: **Context** (PM-stated framing parked from Phase 1), **Updates made** (every file created), **Decisions** (cohort definitions, journey stages, sources registered), **Open** (TBDs per source, deferred items).
3. Present handoff: *"Knowledge base ready. What kind of analysis do you want to start with?"*
   - *"Walk a funnel"* → `/explore` (funnel mode)
   - *"Track a metric"* → `/explore` (metric mode)
   - *"Investigate a known problem"* → `/investigate` (signal mode)
   - *"Quick lookup"* → `/discuss`

**Outputs** (atomic, inline — Phase 5 doesn't terminate until ALL land):
- `CLAUDE.md` skeleton.
- `sessions/<CURRENT_SESSION>.md` (created with onboarding section).

**Exit gate:** both files written; handoff prompt delivered.

---

## Failure modes (named drift to avoid)

- Dumping the full questionnaire upfront — flow conversationally, one question at a time, ground each with why it matters.
- Overwriting existing `knowledge/` content without PM confirmation — pre-check halts the skill if product is already onboarded.
- Skipping data-source registration to "get to analysis faster" — every downstream skill halts without ≥1 source in INDEX.md. Phase 3 is non-negotiable.
- Treating onboarding as one-shot — PM can return to add sources, screens, or competitors any time. Skill is idempotent; partial state is fine.
- Capturing too much in product-context.md — 200-line hard limit; deeper detail belongs in glossary.md, personas.md, or per-source files.
- Putting PM hypotheses or pain points in product-context — knowledge stays neutral. Pain points go to the session log.
- Marking a source as registered when half the schema is guessed — explicit `TBD` flags, never silent omission.
- Phase 5 partial completion — exit gate blocks termination until skeleton + session both written. No "I'll wrap up next time."

## Out of scope

- Running data analysis → `/explore` or `/investigate`
- Generating hypotheses → `/explore`
- Filing tickets → `/ship`
- Free-form Q&A about the product post-onboarding → `/discuss`
- Persisting freeform discoveries unrelated to onboarding → `/document-update`

## Delegation

| Task | Agent |
|---|---|
| Detect partial-onboarding state (read product-context, INDEX) | `@schema-reader` (Haiku) |
| Write product-context, per-source files, INDEX rows, CLAUDE.md skeleton, session | `@knowledge-updater` (Haiku) |
| Conversational prompts, content drafting, product-context structuring | Main (Sonnet) |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `knowledge/product-context.md` | Create or update | Phase 2 |
| `knowledge/data-sources/INDEX.md` | Append row per source | Phase 3 |
| `knowledge/data-sources/<source>/connection.md` | Create | Phase 3 |
| `knowledge/data-sources/<source>/schema.md` | Create | Phase 3 |
| `knowledge/data-sources/<source>/gotchas.md` | Create | Phase 3 |
| `knowledge/data-sources/<source>/queries.md` | Create (empty stub) | Phase 3 |
| `knowledge/screens/<flow>/` | Create directory + place screens | Phase 4 (optional) |
| `knowledge/competitors/<competitor>/` + `comparison.md` | Create | Phase 4 (optional) |
| `CLAUDE.md` (product-specific skeleton) | Create | Phase 5 |
| `sessions/<CURRENT_SESSION>.md` | Create with onboarding section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 5 |

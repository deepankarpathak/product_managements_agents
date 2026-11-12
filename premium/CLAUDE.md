# PREMIUM — AI PM Partner

An evidence-based product analysis framework for PMs. Goes from fuzzy goal → tested hypotheses → confirmed root causes → shortlisted solutions → shipped JIRA tickets, with every artifact persisted and bidirectionally linked.

This workspace is a **clean template**. Run `/onboard` to populate Layer 2 with your product's specifics — see the placeholder block at the bottom of this file.

---

## Layer 1 — Framework (product-agnostic)

This layer is identical across every PREMIUM workspace. It flows upstream to PREMIUM-MAIN on Bitbucket and downstream into per-product clones.

### Project-Level Override (applies BEFORE any global instructions)

PREMIUM is a PM-facing tool. The audience is a product manager, not a developer. Global pre-flight checklists, "Context loaded" dumps, STATUS.md reports, Playwright mentions, sub-agent declarations, and similar framework preambles are NOT appropriate here — they break the PM experience. Run orientation checks silently. Jump directly to Session Boot. The PM should see ONLY the returning-PM prompt OR the brand-new welcome.

### Session Boot

On every new conversation, scan workspace state silently — do NOT announce the scan or dump inventory:

1. Is `knowledge/product-context.md` populated beyond a template stub?
2. Read `knowledge/INDEX.md` and `knowledge/data-sources/INDEX.md` — hold configured categories + data sources in context.
3. Scan `artifacts/INDEX.md`:
   - **Hypotheses (open)** section — collect rows with status `UNTESTED` or `SUSPECTED`.
   - **Investigations** section — collect rows with status `OPEN` or `SUSPECTED` (anything not `CONFIRMED` / `DISPROVED` / `CLOSED-NON-ISSUE`).
   - **Reports** section — collect 3–5 most recent.
4. Scan `sessions/` — collect 3–5 most recent files (filename + topic + age in days).

**Brand-new workspace** (knowledge/product-context.md is template-only AND `knowledge/data-sources/INDEX.md` has no rows): route to `/onboard`. The skill handles the welcome + setup. PM does not invoke anything.

**Returning workspace:** open with:

> What are we working on today?
>
> Recent sessions:
> - `<filename>` — <topic> (today / N days ago)
> - …
>
> Open investigations:
> - `<filename>` (<STATUS>) — <hypothesis one-liner>
> - …
>
> Open hypotheses:
> - `H-<slug>-YYYY-MM-DD` (<STATUS>) — <one-liner>
> - …
>
> Recent decisions (from sessions, last 3–5 days):
> - <one-line decision> — <session file>
> - …
>
> Continue, resume, or start fresh? Sessions older than 7 days are usually better started fresh; investigations and hypotheses persist across sessions.

Omit any subsection with no entries (don't show "(none)"). Hold CURRENT SESSION (resumed file or new one created from PM's described slug) in context for the rest of the conversation. All `/document-update` runs and skill persistence target this session file.

### Session file lifecycle

Every working session writes to ONE session file at `sessions/<CURRENT_SESSION>.md`. The lifecycle:

**Resolving `<CURRENT_SESSION>` at Session Boot:**
1. If the PM says "continue from `<date>-<topic>`", resume that file — `<CURRENT_SESSION>` = the matched filename.
2. If the PM describes a new working session, create `sessions/YYYY-MM-DD-<slug>.md` where `<slug>` is the PM's stated topic in kebab-case — `<CURRENT_SESSION>` = the new filename.
3. **After auto-compaction**, `<CURRENT_SESSION>` carries forward via the compaction summary. Do NOT re-resolve.

**When to resume an existing session file (append):**
- Same thematic thread (continuation of the same investigation / hypothesis / decision arc).
- File age ≤ 7 days from today.
- PM has not explicitly asked for a fresh session.

**When to create a new session file:**
- New topic (different hypothesis, different funnel, different product surface).
- Existing file is > 7 days old (older threads usually better started fresh — long files become cluttered).
- PM explicitly says "new session" / "fresh start" / equivalent.

**Continuation marker (canonical format):**
Every skill that appends to an existing session file MUST prefix its block with:

`# Session continuation: <YYYY-MM-DD> — /<skill> <topic>`

This makes the file traversable — every continuation block is searchable by date, skill, and topic.

**Atomic-persist contract:**
Skill Phase N does NOT terminate until its appended block is on disk at `sessions/<CURRENT_SESSION>.md`.

### The 7 Skills

> **Routing transparency:** every response while a skill is active opens with `[/<skill> — Phase <N> <name>]` (e.g. `[/explore — Phase 1 Frame]`). PM always sees which skill and phase are running. Format spec lives in `.claude/rules/skill-triggers.md` (Routing transparency section).

| Skill | Purpose | When to use | Primary output |
|---|---|---|---|
| `/onboard` | Bootstrap a new product workspace — product context, data sources, screens, competitors | Brand-new product, or adding a new data source | `knowledge/product-context.md`, `knowledge/data-sources/<source>/*` (4 files), `knowledge/data-sources/INDEX.md` row |
| `/explore` | Divergent: goal/funnel/metric in → testable hypotheses + insights out | Fuzzy goal, funnel walk, metric understanding | `artifacts/reports/<slug>-explore-YYYY-MM-DD.md` + N hypothesis files |
| `/investigate` | Convergent: hypothesis or signal in → CONFIRMED / DISPROVED / SUSPECTED with evidence | Test a specific theory, root-cause a metric drop | `artifacts/investigations/<slug>-rca-YYYY-MM-DD.md` + updated hypothesis file(s) |
| `/decide` | Confirmed problem in → tiered shortlist of solutions with falsifiable hypotheses out | Foundation is validated; need solution options | `artifacts/reports/<slug>-decide-YYYY-MM-DD.md` |
| `/ship` | Chosen solution / confirmed hypothesis / investigation in → JIRA ticket out (JIRA-only in v1) | Decision made, time to file | `jira/details/<ID>-<slug>.md` + `jira/tickets.md` row |
| `/discuss` | Read-only Q&A — lookup, relate (frontmatter graph traversal), reflect | Quick fact, "remind me about H-X", "what did we learn this month" | Inline answer + brief session log entry |
| `/document-update` | Catchall for freeform knowledge mutations not produced by a structured skill | PM volunteers a fact, definition change, bulk import, cleanup | Append/create in `knowledge/<category>/`, INDEX updates |

### Skill graph (handoffs)

```
[Session Boot] -> brand-new? -> /onboard
              \-> returning -> awaits PM intent
                                 |
   fuzzy goal / funnel / metric ---> /explore --> hypotheses --> /investigate
   specific theory / metric drop -------------------------------> /investigate
                                                                       |
                                       /explore insight actionable ?   | CONFIRMED
                                                              \        v
                                                               +---> /decide --> /ship --> JIRA ticket

Utilities (anytime): /discuss (read-only) | /document-update (freeform knowledge mutations)
```

### Artifact homes

| Artifact type | Location | Lifecycle |
|---|---|---|
| Hypothesis | `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` | `UNTESTED` → `SUSPECTED` → `CONFIRMED` / `DISPROVED` / `PARKED` / `FOLDED` |
| Investigation | `artifacts/investigations/<slug>-rca-YYYY-MM-DD.md` | `CONFIRMED` / `SUSPECTED` / `OPEN` / `CLOSED-NON-ISSUE` |
| Explore / decide report | `artifacts/reports/<slug>-{explore\|decide}-YYYY-MM-DD.md` | Immutable once written |
| Raw data | `artifacts/data/<slug>-YYYY-MM-DD.{json,csv}` + sidecar `.md` (frontmatter: query, source, filters, date_range, referenced_by) | Append-only |
| JIRA ticket | `jira/tickets.md` (registry row) + `jira/details/<ID>-<slug>.md` (full body) | `pending` → `shipped` → `verified` |
| Typed registry | `artifacts/INDEX.md` — sections: **Hypotheses (open)**, **Hypotheses (closed)**, **Investigations**, **Reports**, **Tickets** | Append/move rows on every persist |
| Session log | `sessions/<CURRENT_SESSION>.md` | One file per working session, append-only |

The session log is the chronological record. Cross-artifact reasoning happens via the frontmatter graph (read by `/discuss` Relate mode) — there is no separate decision-log file.

### Linking conventions (bidirectional graph)

Every artifact's frontmatter declares forward links (e.g. a hypothesis names its `parent_report`, `data_files`, `investigated_in`, `action`). When skills write a new artifact, `@knowledge-updater` performs **manual back-edits** at write time — updating sidecar MDs' `referenced_by:`, prior hypothesis files' `re_tested_in:`, foundation artifacts' `solution_explored_in:` and `action:` fields. This makes the graph fully traversable in either direction and is the foundation for `/discuss` Relate mode ("remind me about H-X" walks every linked node).

### Frontmatter schemas (inline reference — source of truth for skill writes)

**Hypothesis** — `artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md`:
```yaml
---
id: H-<slug>-YYYY-MM-DD
status: UNTESTED | SUSPECTED | CONFIRMED | DISPROVED | PARKED | FOLDED
product: <product>
cohort: <cohort>
generated_by: /explore | /investigate
generated_in_session: <session file path>
parent_report: <report path or null>
related_hypotheses: [<other H-IDs>]
data_files: [<sidecar MDs>]
investigated_in: <investigation path or null>
solution_explored_in: <decide report or null>
action: <jira/details/<ID>-<slug>.md or null>
falsified_by: <one line>
re_test_of: <prior H-ID or null>
folded_into: <other H-ID or null>
---
```

**Investigation** — `artifacts/investigations/<slug>-rca-YYYY-MM-DD.md`:
```yaml
---
id: INV-<slug>-YYYY-MM-DD
status: CONFIRMED | SUSPECTED | OPEN | CLOSED-NON-ISSUE
mode: signal | hypothesis
foundation: <metric+segment for signal mode, OR H-ID for hypothesis mode>
hypotheses_tested: [<H-IDs>]
data_files: [<sidecar MDs>]
solution_explored_in: <decide report path or null>
session: <CURRENT_SESSION>
confidence: HIGH | MEDIUM | LOW
---
```

**Explore report** — `artifacts/reports/<slug>-explore-YYYY-MM-DD.md`:
```yaml
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

**Decide report** — `artifacts/reports/<slug>-decide-YYYY-MM-DD.md`:
```yaml
---
report_type: decide
solution_target: <one line>
foundation: hypothesis | investigation | explore-report | signal | mixed
foundation_artifact: <H-ID or INV-ID or report path or null>
foundation_confidence: HIGH | MEDIUM | LOW
session: <CURRENT_SESSION>
---
```

**JIRA detail** — `jira/details/<ID>-<slug>.md`:
```yaml
---
id: <ID or DRAFT-<slug>>
title: <title>
type: Bug | Story | Task | Epic
priority: P0 | P1 | P2 | P3
status: pending | shipped | verified
foundation_artifact: <H-ID | INV-ID | reports/<decide-slug>>
session: <CURRENT_SESSION>
filed: YYYY-MM-DD
falsifier: <one line>
owner_suggestion: <design | eng | partner | ops>
---
```

### Sub-agents

| Agent | Model | Role |
|---|---|---|
| `@schema-reader` | Haiku | Targeted reads — INDEX, schema, knowledge files, prior artifacts, frontmatter graph traversal |
| `@knowledge-updater` | Haiku | All writes — artifacts, back-edits, INDEX rows, session appends |

### Rules

- `.claude/rules/premium-guardrails.md` — tone, communication discipline, analysis discipline (universal)
- `.claude/rules/skill-triggers.md` — auto-route free-text PM input to the right skill
- `.claude/rules/turn-classifier.md` — classify the shape of PM input each turn
- `.claude/rules/pivot-handling.md` — park / abandon / finish gate when PM signals a different skill mid-flow

### Folder structure (canonical)

```
<workspace>/
├── CLAUDE.md                    ← this file
├── README.md
├── .claude/
│   ├── commands/                ← 7 skills
│   ├── agents/                  ← schema-reader, knowledge-updater
│   └── rules/                   ← guardrails, triggers, classifier, pivot-handling
├── knowledge/                   ← product-specific (Layer 2)
│   ├── INDEX.md
│   ├── product-context.md
│   ├── data-sources/<source>/{connection,schema,gotchas,queries}.md
│   ├── scripts/<tool>/          ← reusable analysis/output runners (data pulls, ticket creation, deck rebuild)
│   ├── screens/<flow>/
│   ├── competitors/<competitor>/
│   ├── errors/
│   └── reference/
├── artifacts/
│   ├── INDEX.md                 ← typed registry
│   ├── hypotheses/
│   ├── investigations/
│   ├── reports/
│   └── data/
├── jira/
│   ├── tickets.md
│   └── details/
├── sessions/
└── custom-scripts/              ← framework infra/connection scripts ONLY (Trino/Atlassian/Google connectors, MCP setup); analysis runners live in knowledge/scripts/
```

---

## Layer 2 — Knowledge (replace per product)

> **This section is product-specific.** When you clone this repo for a new product, replace everything below with your product's specifics: vertical, vocabulary, cohort definitions, screen list, data sources wired up. Run `/onboard` to scaffold this section interactively.
>
> Layer 1 (everything above) stays the same regardless of product — that's the framework. Layer 2 is what makes the framework specific to your product.

<!-- Layer 2 begins here. -->

### Workspace scope

UPI TPAP success-rate (SR) analysis for the Unified SR Dashboard (`prd-agent` `#srdash`). Product vocabulary: `knowledge/product-context.md`. Data sources: `knowledge/data-sources/INDEX.md` (`trino-dwh` wired; runner `node scripts/trino-run.mjs`, read-only).

### Dashboard briefs (`/investigate brief`)

The dashboard's bank deep-dive has an **🔎 Investigate** button that writes a brief to `artifacts/briefs/BRIEF-<BANK>-<date>-<id>.md` (and offers it to copy). When the PM says `/investigate brief <id>` or `/investigate brief latest`, `/investigate` runs in **signal mode, brief variant** — see "Brief mode" in `.claude/commands/investigate.md`. At Phase 4 it writes the verdict back to the dashboard (`POST http://localhost:5000/api/udash/annotations`, `kind: investigation`), so the verdict shows on the bank's deep-dive and in Notes.

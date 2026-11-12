# Changelog

All notable changes to PREMIUM-EXPORT are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/):
- **MAJOR** — breaking change to skill or agent contracts (rare).
- **MINOR** — new skill, new agent, new knowledge category, or other additive change.
- **PATCH** — bug fix, doc clarification, internal cleanup.

---

## [Unreleased]

### Added
- `custom-scripts/bitbucket-connect/README.md` — Bitbucket Cloud authentication methodology (SSH, App Password, OAuth) with the explicit note that Atlassian API tokens do not work for Bitbucket.
- `custom-scripts/INDEX.md` — registered the new `bitbucket-connect/` folder.

---

## [0.2.0] — 2026-05-08

Architecture sync: replaces the v0.1.0 skill set with a tighter 7-skill state-machine model, introduces the read/write agent split, formalizes the artifact graph, and adds Pull mode + Phase 0 audit.

### Added
- **5 main-flow skills:** `/onboard`, `/explore`, `/investigate`, `/decide`, `/ship`. Each is a phased state machine with inline atomic persist (Phase N doesn't terminate until all expected outputs are on disk).
- **2 utility skills:** `/discuss` (Lookup / Relate / Reflect / **Pull** modes) and `/document-update` (now with **Phase 0 skill-completion audit** that autonomously detects the last skill from conversation tags + filesystem mtime and verifies its expected outputs landed).
- **`/discuss` Pull mode** — single-query data fetch for specific measurable questions. Hard guardrail: ONE query → ONE answer → save to `artifacts/data/<question-slug>-discuss-<date>/` with sidecar provenance frontmatter. Multi-cut follow-ups route to `/explore`.
- **Two agents:** `schema-reader` (read-only Haiku) and `knowledge-updater` (write-only Haiku). Read/write split keeps responsibilities clean and constrains the write surface.
- **Three new rules:** `skill-triggers.md` (auto-trigger phrase map + routing transparency tags), `turn-classifier.md` (free-text classification when no phrase matches), `pivot-handling.md` (park/abandon/finish gate when PM signals a different skill mid-flow).
- **`knowledge/scripts/`** — new home for reusable analysis runners (data pulls, deck builds, ticket scripts). Has its own typed INDEX with promotion criteria. `custom-scripts/` is now strictly for framework infra/connection helpers.
- **Per-run artifact-data folder convention** — `/explore` and `/investigate` save data into `artifacts/data/<report-slug>-<skill>-<date>/` with one `<query-slug>.{json,csv}` + `<query-slug>.md` sidecar per query. Sidecar mandates 10-field frontmatter (data_file, source, cohort, query, filters, date_range, generated_by, generated_in_session, script, referenced_by) for full provenance.
- **Hypothesis lifecycle fields** — frontmatter now includes `solution_explored_in`, `re_test_of`, `folded_into` to track the hypothesis through `/decide`, re-tests, and folds.
- **Typed `artifacts/INDEX.md` registry** — explicit sections (Hypotheses open/closed, Investigations, Reports, Tickets, Data files) with append-on-write contract; replaces the v0.1.0 free-form list.
- **Bidirectional artifact graph** — every artifact's frontmatter declares forward links; `@knowledge-updater` performs manual back-edits at write time so the graph traverses both directions (foundation for `/discuss` Relate mode).
- **`README.md`** — full rewrite covering folder structure, knowledge-base build steps, 7-skill workflow with example chain, persistence model.
- **`CLAUDE.md`** — Layer 1 (framework, product-agnostic) + Layer 2 placeholder (run `/onboard` to populate per product). Includes Session Boot scan, Routing transparency contract, Frontmatter schemas inline, Skill graph (handoffs).

### Changed
- **Skill set retired and replaced.** `/start-product` → `/onboard`. `/analyze-funnel`, `/data-analysis`, `/create-funnel` → `/explore`. `/analyze-hypothesis`, `/rca`, `/measure` → `/investigate`. `/solution-exploration` → `/decide`. `/create-jira` → `/ship`. `/update-funnel-map` → folded into `/explore` and `/document-update`.
- **`/document-update`** — now supports an optional Phase 0 skill-completion audit before the existing infer/locate/persist phases.
- **`custom-scripts/INDEX.md` charter** — narrowed to framework infra/connection helpers only. Analysis runners moved to `knowledge/scripts/`.

### Removed
- **`DESIGN.md`** — the skill specs are now self-documenting (each has Phase index, Exit gates, File outputs, Failure modes inline). Maintaining a separate design doc duplicated content and rotted fast. CLAUDE.md + the skill files in `.claude/commands/` are now the canonical design.
- **Stale skill files** — `start-product.md`, `analyze-funnel.md`, `analyze-hypothesis.md`, `data-analysis.md`, `create-funnel.md`, `rca.md`, `solution-exploration.md`, `create-jira.md`, `update-funnel-map.md`, `measure.md`.
- **`knowledge/funnels/`** — legacy folder for the retired `/create-funnel` skill.

### Migration notes
- Existing v0.1.0 product workspaces should re-clone Layer 1 from this version. Layer 2 (knowledge/, artifacts/, sessions/, jira/) carries forward unchanged.
- Old session logs and artifacts written under v0.1.0 conventions remain readable but use the older flat `artifacts/data/<slug>-<date>.{json,csv}` pattern. New runs land in per-run subfolders. No migration script — old data stays where it is.
- Skills loaded at session start are cached; existing live sessions need a restart to pick up v0.2.0 specs.

### Hardening
- **`/investigate` Phase 3 step 1**: `connection.md` added to schema-reader required reads (mirrors `/explore` Phase 2). Closes a v0.2.0 back-port gap surfaced when an investigate session drafted SQL without first locating the runner script.
- **`/explore` Phase 2 + `/investigate` Phase 3 — runner confirmation**: agent must state the runner path from `<source>/connection.md` and ask the PM to confirm before running the first query of a phase. Subsequent queries against the same source auto-run; re-confirm only when source changes. Replaces an earlier draft of this gate (a 4-row declaration table) which was prone to fabricated "PM-run" declarations without verifying the connection. New failure modes documented: drafting SQL without confirmation, re-asking on every query, fabricating a "no runner" reason without quoting from `connection.md`.
- **CLAUDE.md — Session file lifecycle**: codifies the resume-vs-create rule for session files (7-day age threshold + topic match), canonical continuation marker format (`# Session continuation: <YYYY-MM-DD> — /<skill> <topic>`), and `<CURRENT_SESSION>` resolution after auto-compaction. Cross-referenced from every skill spec's `## File outputs` table. Closes an emergent-convention gap surfaced when `/document-update` appended to a 4-day-old session file post-compaction without spec guidance.

---

## [0.1.0] — 2026-05-05

### Added
- Initial publication of the PREMIUM-EXPORT framework.
- Three skills: `/start-product`, `/document-update`, `/create-jira`.
- Two skills under iteration: `/analyze-funnel`, `/create-funnel`.
- Two agents: `schema-reader` (Haiku), `knowledge-updater` (Haiku).
- One rule: `premium-guardrails.md` (universal PM thinking and communication rules).
- Knowledge structure with INDEX-driven routing (`knowledge/`, `data-sources/`, `components/`, `funnels/`, `competitors/`, `errors/`, `reference/`, `screens/`).
- `artifacts/` for generated outputs (`data/`, `reports/`, `dashboards/`, `investigations/`).
- `jira/` for ticket tracking and details.
- `custom-scripts/` with connection methodology docs (Atlassian, Google Workspace, data warehouse, MCP).
- `DESIGN.md` author-facing blueprint.
- `README.md` and `CLAUDE.md` for PM-facing onboarding.

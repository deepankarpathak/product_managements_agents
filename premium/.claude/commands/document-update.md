---
description: Catchall for knowledge mutations that don't come out of a structured skill run — freeform discoveries, product context changes, knowledge cleanup, bulk imports. Inference-driven: scans the recent session and proposes what to persist before asking.
---

# /document-update — Knowledge mutation catchall

**Model:** Sonnet (classification and inference are the hard part).

## When to run
- PM volunteers a fact mid-conversation that should persist (*"BBPBFR009 is SBI-specific, not generic"*)
- PM re-states a foundational definition (*"react user definition changed to 60+ days"*)
- PM wants to clean up, restructure, or fix stale sections in knowledge
- PM has a doc, spreadsheet, or notes to ingest in bulk

**Not for:** routing skill outputs. Skills now persist their own artifacts atomically — don't use this skill to file `/explore` or `/investigate` outputs.

**Pre-check:** none — works off conversation context.

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 0 | Skill-completion audit (safety net) | Audit verdict reported (PASS or gap list); back-fill scope decided if gaps found |
| 1 | Infer + propose | PM confirmed (or edited) the proposed list of discoveries to persist |
| 2 | Locate target | Target file(s) identified for each approved discovery; new-file approval obtained if needed |
| 3 | Diff + persist | All writes landed via @knowledge-updater; back-link comments in place; session appended |

---

## Phase 0 — Skill-completion audit

**Goal:** detect which skill last ran and verify its expected artifacts are on disk. This is a **safety net** for the Phase-N atomic persist gates inside each main skill — it catches what slipped past, it does not replace per-skill exit gates. The ideal state is that this audit always returns PASS.

**Skill detection (autonomous — no PM ask):**

1. **Conversation tag scan (primary).** Look back through the most recent assistant turns in this conversation context. Find the most recent routing tag of the form `[/<skill> — Phase <N> <name>]`. **Skip any `[/document-update — ...]` tag** (that's self) — find the one before it. The skill named in that tag is the audit target. Also note the highest phase number the skill reached (its progress).
2. **Filesystem scan (fallback if no tag found in context — e.g. compacted away).** Run `ls -lt` on artifact dirs. Map most-recently-touched dir to skill:
   - `artifacts/hypotheses/` recent → `/explore`
   - `artifacts/investigations/` recent → `/investigate`
   - `artifacts/reports/<slug>-decide-*.md` recent → `/decide`
   - `artifacts/jira/details/` recent → `/ship`
   - Pick the most recently mtime'd dir (within this session window). That maps to the skill.
3. **No skill detected (no tag, no recent writes):** no audit needed. Skip Phase 0 silently and proceed to Phase 1. Do NOT ask the PM.

**Audit (once skill is identified):**

1. `@schema-reader` reads `.claude/commands/<skill>.md` and extracts the `## File outputs` table at the bottom.
2. For each row in the outputs table (file path + action + trigger phase), check via `ls`/`Read`:
   - Does the file exist?
   - Was it touched within this session window? (mtime ≥ session start)
   - Is the content non-empty / well-formed (frontmatter present where expected)?
3. **Adjust expectations to skill progress.** If the skill only reached Phase 2, only Phase 2's expected outputs are mandatory. Phase 3+ outputs are not gaps — they're "not yet attempted."
4. Build a verdict:
   - **PASS:** all expected outputs for reached phases exist + are session-fresh + well-formed.
   - **GAP:** one or more outputs missing, stale, or malformed. Surface as a list:
     ```
     /<skill> reached Phase <N>. Expected outputs from that phase:
     ✗ artifacts/hypotheses/H-<slug>-<date>.md — MISSING
     ✓ artifacts/reports/<slug>-explore-<date>.md — present
     ✗ sessions/<session>.md — exists but no Phase 4 section appended
     Back-fill these now (a), accept the gap with a documented reason (b), or skip audit and continue (c)?
     ```
5. PM picks (a/b/c). If (a) → fold the back-fill items into Phase 1's discovery list and persist them in Phase 3. If (b) → log the gap + reason in `sessions/<CURRENT_SESSION>.md` under **Audit gaps accepted**. If (c) → log "audit skipped by PM" in session.

**Output telemetry:** even on PASS, state one line: *"Audit: `/<skill>` reached Phase `<N>` — all `<M>` expected artifacts present."* PM should always know the audit ran.

**Outputs:** working state — audit verdict; if gaps found and PM picked (a), back-fill items added to Phase 1's discovery list.

**Exit gate:** audit verdict reported AND back-fill scope decided (a/b/c) AND any accepted gaps logged to session.

---

## Phase 1 — Infer + propose

**Goal:** scan recent session context, classify what's worth persisting, propose to PM. Skill does the inference; PM only confirms or edits.

**Steps:**
1. `@schema-reader` reads the current session file (`sessions/<CURRENT_SESSION>.md`) and the most recent 1–2 prior session files in `sessions/`. Extract: PM-volunteered facts, redefinitions, codes/mappings stated, doc dumps, anything PM said *"save this"* or *"remember this"* about.
2. **Inference pass (main, Sonnet).** From the loaded context, identify candidates worth persisting. Apply the four-job filter:
   - **Freeform discovery** — a fact stated mid-conversation with structural value (error code meaning, field semantics, source quirk)
   - **Product context change** — redefinition of a foundational term (cohort, segment, journey stage)
   - **Knowledge cleanup** — stale section flagged, error noted, restructure requested
   - **Bulk import** — a doc, spreadsheet, paste, or attached file the PM wants ingested
3. If no candidates found AND skill was invoked with no recent context: ask PM directly: *"What would you like to capture?"* (single, narrow question — don't interrogate.)
4. If candidates found, propose them inline:
   ```
   I see <N> things worth saving from this session:
   (a) <one-line description of discovery 1> → likely target: <file path or category>
   (b) <one-line description of discovery 2> → likely target: <file path or category>
   ...
   Confirm, edit, or strike any of these.
   ```
5. PM confirms, edits descriptions, strikes items, or adds new ones. Do not proceed with anything PM struck.

**Outputs:** working state — confirmed list of discoveries with proposed targets.

**Exit gate:** PM confirmed the list (or skill exited because nothing was worth persisting).

---

## Phase 2 — Locate target

**Goal:** for each approved discovery, identify the exact knowledge file (existing or new) where it belongs.

**Steps:**
1. `@schema-reader` reads `knowledge/INDEX.md` (always) and any sub-INDEX files implicated by the discoveries:
   - Data/source/query/filter signals → `knowledge/data-sources/INDEX.md`
   - Error codes / user messages → `knowledge/errors/INDEX.md` if it exists, else direct read of `knowledge/errors/mapping.md`
   - PRDs, research, shared docs → `knowledge/reference/INDEX.md`
   - Product context redefinitions → `knowledge/product-context.md` (read directly)
2. For each discovery, match against INDEX entries using each entry's **Update when:** guidance.
   - **Single match** → that's the target.
   - **Multiple matches** → discovery spans files; route to all matching targets (one approval row per target).
   - **No match** → propose to PM:
     - **A)** Create new file under an existing category (e.g. `knowledge/data-sources/<source>/<new-file>.md`) — PM approves filename + initial structure.
     - **B)** Fold into `knowledge/product-context.md` (lightest option, default for context-type discoveries).
     - **C)** Defer — don't persist this run; note in session log Deferred section.
3. **Whitelist guard for new categories.** Approved top-level categories: `data-sources/`, `errors/`, `screens/`, `competitors/`, `reference/`, `scripts/`, `product-context.md`. If PM proposes a new top-level category not on this list, push back: *"Knowledge root is whitelisted — `<proposed>` doesn't fit any existing category. Want to (a) place under one of `<list>`, (b) reconsider, or (c) confirm a new top-level category and accept the sprawl risk?"*
4. For bulk imports (doc / spreadsheet / paste): the original gets saved to `knowledge/reference/<descriptive-filename>` AND extracted facts go to specific knowledge files. Both halves surfaced as separate items in Phase 3.

**Outputs:** working state — each approved discovery now has a confirmed target file (existing or new with PM approval).

**Exit gate:** all discoveries have a target; new-file approvals obtained where needed.

---

## Phase 3 — Diff + persist

**Goal:** show PM the exact additions before writing, persist atomically with back-link comments, append session.

**Steps:**
1. For each discovery, draft the exact text addition (the diff). Show inline:
   ```
   File: knowledge/data-sources/pulse/errors.md
   Section: ## SBI-specific codes
   Adding:
     - BBPBFR009 — SBI-specific (not generic). Indicates <one line>.
       <!-- Discovered 2026-05-07 in sessions/2026-05-07-sbi-investigation.md / from hypothesis H-bank-confusion-2026-05-07 -->
   ```
2. PM reviews all diffs at once (or row-by-row if list is long — offer the choice when 4+ diffs are pending). PM approves, edits text, or skips individual rows.
3. **Atomic persist.** Phase 3 doesn't terminate until all approved writes + back-links + session writes land. If any single write fails, halt and report to PM — do not proceed with partial state.

**Outputs** (atomic, inline):
- `@knowledge-updater` writes each approved addition to its target file. The agent enforces duplicate-check (substring or near-semantic match) — if duplicate found, skip and report. Every addition includes the back-link comment:
  ```
  <!-- Discovered YYYY-MM-DD in sessions/<file> / from <hypothesis ID or 'PM context'> -->
  ```
- `@knowledge-updater` writes new files (Phase 2 outcome A) with PM-approved structure. Adds entry to the relevant INDEX with mandatory **Contains:** and **Update when:** lines.
- `@knowledge-updater` saves bulk-imported originals to `knowledge/reference/<filename>` and adds a row to `knowledge/reference/INDEX.md` (type, received date, one-line summary).
- `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md` under **Updates made**: pointer lines like `- knowledge/errors/mapping.md: added BBPBFR009 SBI-specific note`. Items skipped via Phase 2(C) go under **Deferred** with reason.

**Exit gate:** all approved writes succeeded (or were duplicate-skipped with a clear reason); session log written.

---

## Failure modes (named drift to avoid)

- **Asking PM "which skill did you just run?"** — Phase 0 detection is autonomous. If conversation tags + filesystem scan both come up empty, skip the audit silently. Don't pester.
- **Treating Phase 0 as a replacement for skill exit gates** — the audit is a safety net. Skills must still enforce their own atomic persist gates. If Phase 0 keeps finding gaps in the same skill, fix that skill's exit gate, don't lean harder on the audit.
- Interrogating PM about what to save when the answer is already in the session — propose first, ask only as fallback.
- Overwriting existing knowledge content without showing the diff — every change goes through Phase 3 review.
- Persisting without back-link comments — every addition cites session + source artifact.
- Creating files in `artifacts/` — out of scope; that's skill-output territory, handled by `/explore`, `/investigate`, `/decide`, `/ship`.
- Sprawling new top-level categories — whitelist enforces; route uncertain proposals back to PM with stricter criteria.
- Silently saving a bulk-import original without also extracting its facts (or vice versa) — both halves surfaced as separate approval rows.
- Bypassing `@knowledge-updater` to write inline — duplicate-check is the agent's job; inline writes break consistency.
- Treating PM mid-phase redirect as permission to skip pending writes — confirm what's being deferred via the Deferred list, never silent.
- **Improvising the session-file resume-vs-create decision.** Apply the lifecycle rule from CLAUDE.md → Session file lifecycle: resume if same thematic thread AND file age ≤ 7 days; create new otherwise. Always use the canonical continuation marker.

## Out of scope

- Generating analysis or hypotheses → `/explore` or `/investigate`
- Creating skill-output artifacts (reports, investigations, hypotheses, solutions, JIRAs) → respective skills' own persist phases
- Tracking hypothesis or investigation lifecycles → `/explore` and `/investigate`
- Quick lookups or relation queries → `/discuss`
- Defining new data sources from scratch — handle inline via Phase 2(A) only if PM provides full registration info; otherwise route to `/onboard`

## Delegation

| Task | Agent |
|---|---|
| Skill detection via conversation tag scan + filesystem mtime check (Phase 0) | Main (Sonnet) — context introspection cannot be delegated |
| Read active skill's `.claude/commands/<skill>.md` for File outputs table (Phase 0) | `@schema-reader` (Haiku) |
| Existence + mtime + frontmatter checks on expected outputs (Phase 0) | Main (Sonnet) — cheap `ls`/`Read` calls |
| Read recent session files (Phase 1) | `@schema-reader` (Haiku) |
| Read knowledge INDEX + target files (Phase 2) | `@schema-reader` (Haiku) |
| Apply writes to knowledge files, append session (Phase 3) | `@knowledge-updater` (Haiku) |
| Inference of what to persist, classification of destination, diff drafting | Main (Sonnet) |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `knowledge/<category>/<file>.md` | Append (or create new file) | Phase 3 |
| `knowledge/INDEX.md` (or sub-INDEX) | Append entry | Phase 3 (only if new file/category created) |
| `knowledge/reference/<filename>` + `reference/INDEX.md` row | Save original + index | Phase 3 (bulk imports only) |
| `sessions/<CURRENT_SESSION>.md` | Append section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 3 (always) |

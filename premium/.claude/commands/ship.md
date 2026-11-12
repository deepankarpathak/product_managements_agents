---
description: Convert a chosen solution, confirmed hypothesis, or investigation conclusion into a concrete, executable JIRA ticket — formatted, evidence-cited, and back-linked to its foundation artifact.
---

# /ship — Convert decision into JIRA ticket

**Model:** Sonnet by default. Switch to Opus only if INR impact reasoning requires cross-source synthesis the foundation artifact didn't already do.

## When to run
- PM has a `/decide` shortlist with a chosen option and wants to file a ticket
- PM has a CONFIRMED hypothesis (from `/investigate`) and wants to file directly without further solutioning
- PM has an investigation conclusion ready to ship as a ticket

**Use `/decide` instead** if PM is still weighing options. This skill assumes the choice is made.

**Pre-check:** none. Foundation gating happens in Phase 1.

## Phase index

| Phase | State | Exit gate |
|---|---|---|
| 1 | Load foundation | Foundation artifact loaded and confirmed |
| 2 | Format | JIRA draft assembled; PM iterated to satisfaction |
| 3 | PM approval | PM approved final draft (or sent back to Phase 2 for edits) |
| 4 | Persist | Artifact written, foundation back-edited, INDEX updated, session appended |

---

## Phase 1 — Load foundation

**Goal:** the source artifact backing the ticket is loaded and confirmed.

**Steps:**
1. Ask PM: *"Which decision, hypothesis, or investigation is the basis for this ticket?"* Foundation is REQUIRED. Acceptable foundations:
   - `/decide` report (`artifacts/reports/<slug>-decide-YYYY-MM-DD.md`) with a chosen option
   - CONFIRMED hypothesis file (`artifacts/hypotheses/H-<slug>-YYYY-MM-DD.md` with `status: CONFIRMED`)
   - Investigation file (`artifacts/investigations/<slug>-YYYY-MM-DD.md` with `status: CONFIRMED`)
   - If PM cannot name one → halt: *"I can't ship without a foundation. Run `/decide`, `/investigate`, or point me to the artifact. Need a fresh investigation? Run `/investigate`."*
2. `@schema-reader` reads the named foundation artifact AND `artifacts/INDEX.md` (locate prior tickets for similar work to avoid duplicates).
3. **Confidence check.** If foundation is a hypothesis or investigation with `confidence: LOW` → flag: *"Foundation is LOW confidence. Shipping on this risks acting on noise. Confirm anyway, or send back to `/decide` / `/investigate`?"* Proceed only on PM override.
4. **Duplicate check.** If INDEX shows a prior ticket on the same foundation → surface: *"You already shipped `<artifact>` on this foundation on `<date>`. Update existing, or new ticket?"*
5. Restate: *"Foundation: `<artifact ID>`. Chosen option / hypothesis / conclusion: `<one line from the foundation>`. Confirm?"*

**Outputs:** nothing persisted yet.

**Exit gate:** foundation loaded and confirmed.

---

## Phase 2 — Format

**Goal:** assemble the JIRA ticket content with PM iteration on title, framing, evidence, and impact.

**Steps:**

1. Extract from foundation: problem statement, evidence (data + sources + dates), proposed action, INR impact (if quantified), falsifier, owner suggestion (if present in `/decide` output).
2. Draft the ticket body in this exact shape — this block is what the PM pastes into Atlassian. Do NOT include internal artifact IDs in this block:
   ```markdown
   ## <Title — concise, action-oriented, under 80 chars>

   **Type:** <Bug | Story | Task | Epic>
   **Priority:** <P0 | P1 | P2 | P3>

   **Problem:**
   <one paragraph, quantified. What's wrong and by how much. Cite the foundation's framing in PM-facing language only.>

   **Evidence:**
   - Source: <data source + filters + date range — no internal artifact IDs here>
   - Key numbers: <specific counts, percentages, rates>
   - Segment: <cohort / platform / user type>

   **Proposed solution:**
   <specific. "Add provider alias mapping for SBI → State Bank of India" not "improve search matching".>

   **Impact:**
   <INR/month, affected users, expected outcome. If foundation didn't quantify → write "Impact: TBD, needs sizing" — do NOT invent a number.>

   **Acceptance criteria:**
   - <measurable outcome 1>
   - <measurable outcome 2>

   **Falsifier:**
   If <data signal> after ship, this didn't work and we revert / re-investigate.

   **Suggested owner:** <design | eng | partner | ops>
   ```
3. PM picks Type + Priority. Suggest Type from foundation kind (bug-rooted hypothesis → Bug; new behavior → Story; ops change → Task; multi-ticket initiative → Epic). PM has final say.
4. Iterate with PM on title, problem framing, acceptance criteria, falsifier wording. Show full draft each round.

**Outputs:** draft held in working state — persisted at Phase 4.

**Exit gate:** PM stops requesting edits.

---

## Phase 3 — PM approval

**Goal:** PM signs off on the full draft before anything is persisted.

**Steps:**
1. Show the full final draft inline as the clean PM-facing block (no internal IDs).
2. PM options: approve as-is, edit specific sections (return to Phase 2), reject (skill ends — nothing persisted).
3. On approval → state what will be persisted: artifact path, foundation back-edit, INDEX row, session entry. *"Writing now. Confirm?"*

**Exit gate:** PM approved.

---

## Phase 4 — Persist

**Goal:** atomic write of artifact + foundation back-edit + INDEX + session. Phase does not terminate until all four land.

**Steps:**
1. `@knowledge-updater` writes `jira/details/<ID>-<slug>.md` with frontmatter:
   ```
   ---
   id: <ID or DRAFT-<slug>>
   title: <title>
   type: Bug | Story | Task | Epic
   priority: P0 | P1 | P2 | P3
   status: pending
   foundation_artifact: <H-ID | INV-ID | reports/<decide-slug>>
   session: <CURRENT_SESSION>
   filed: YYYY-MM-DD
   falsifier: <one line>
   owner_suggestion: <design | eng | partner | ops>
   ---
   ```
   Body: the full PM-facing JIRA block from Phase 2 (clean, no internal IDs in body).
2. `@knowledge-updater` appends a row to `jira/tickets.md`: `| ID | Title | Priority | Status | Filed | Foundation | Falsifier |` with `Status: pending` and `Foundation` linking to the artifact ID.
3. `@knowledge-updater` back-edits the foundation artifact: set `action: jira/details/<ID>-<slug>.md` and `action_status: pending`. If foundation is a hypothesis with `status: CONFIRMED`, leave status; do not regress it.
4. `@knowledge-updater` updates `artifacts/INDEX.md` typed registry: append a row to the **Tickets** section (create section if missing). Row links artifact path + foundation ID + status.
5. `@knowledge-updater` appends to `sessions/<CURRENT_SESSION>.md`: artifact created (path + ID), foundation back-edited, decisions PM made during drafting (priority, type, scope edits).

**Exit gate:** all four (artifact, foundation back-edit, INDEX row, session) written.

**Next step prompt:**
- *"Ticket drafted at `<path>`. Copy the body block into Atlassian. Run `/document-update` once filed to mark `pending` → `shipped`, and again post-deploy to mark `verified`."*

---

## Failure modes (named drift to avoid)

- Filing without a foundation artifact — refuse, route to `/decide` or `/investigate`.
- Auto-filling INR impact when foundation didn't quantify it — flag as "Impact: TBD, needs sizing" instead.
- Skipping foundation back-edit at Phase 4 — `action:` field MUST be set on the source hypothesis or investigation; otherwise tracking breaks.
- Pasting internal artifact IDs into the JIRA-facing description block — local detail file holds the links, ticket body stays clean PM-facing prose.
- Treating LOW foundation confidence as ship-ready — flag and ask PM to confirm or send back upstream.
- Inventing acceptance criteria the foundation didn't support — derive from foundation; ask PM if gaps exist.

## Out of scope

- Defining the problem → `/explore` or `/investigate`
- Generating solution options → `/decide`
- Pushing to Atlassian directly — out of PREMIUM scope; PM copy-pastes from the formatted block
- Tracking JIRA status changes after creation → `/document-update` (v1); `/ship` status-update mode considered for v2
- Designing A/B experiments — out of scope for v1; experiment mode planned for v2
- Writing stakeholder memos — out of scope for v1; memo mode planned for v2
- Persisting freeform knowledge unrelated to this ship action → `/document-update`

## Delegation

| Task | Agent |
|---|---|
| Read foundation artifact, INDEX, prior tickets | `@schema-reader` (Haiku) |
| Write JIRA detail file, back-edit foundation, append tickets.md row, INDEX update, session | `@knowledge-updater` (Haiku) |
| Title / prose / acceptance criteria drafting, INR reasoning | Main (Sonnet) |
| Multi-source impact synthesis foundation didn't already do | Switch to Opus mid-session |

## File outputs

| File | Action | Trigger |
|---|---|---|
| `jira/details/<ID>-<slug>.md` | Create | Phase 4 |
| `jira/tickets.md` | Append row | Phase 4 |
| Foundation artifact (`H-*` / `INV-*` / decide report) | Back-edit `action:` + `action_status:` | Phase 4 |
| `artifacts/INDEX.md` (Tickets section) | Append row | Phase 4 |
| `sessions/<CURRENT_SESSION>.md` | Append section (see CLAUDE.md → Session file lifecycle for resume-vs-create rules) | Phase 4 |

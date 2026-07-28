---
name: JIRABuild
description: >
  Build/run the standalone JIRA-agent app (prd-agent/JIRA-agent) AND/OR generate
  its 18-section CAB-ready UPI/NPCI JIRA ticket directly in chat/CLI without the
  app running. Trigger on `/JIRABuild`, "build the jira agent", "run JIRA-agent",
  "start jira-agent app", or a feature description asking for a full CAB JIRA
  ticket in JIRA-agent style. Rooted at ~/prd-agent/JIRA-agent — a standalone Vite
  + React app (JiraAgent.jsx) that calls the Anthropic API directly from the
  browser. Two modes: LAUNCH (npm install + npm run dev, serves at localhost:3000)
  or GENERATE (Claude drafts the ticket itself, no server/API key needed). Does
  not touch prd-agent/backend/server.js or the /jiragenerator skill (that one
  creates real Jira tickets via the backend; this one is the standalone app +
  raw-markdown generator, output only, no Jira write).
---

# /JIRABuild — JIRA-agent App Builder + Ticket Generator

Two independent modes. Pick based on what user asks; default to GENERATE if
ambiguous (no server needed, fastest response).

**App root:** `~/prd-agent/JIRA-agent` (standalone Vite+React app, port 3000 —
separate from main monorepo's JIRA tab at `prd-agent/src/jira-agent.jsx`).

---

## Mode 1 — LAUNCH (build/run the app)

Trigger words: "build", "run", "start", "launch" + "JIRA-agent"/"jira agent app".

1. `cd ~/prd-agent/JIRA-agent`
2. If `node_modules` missing: `npm install`
3. If `.env` missing and `.env.example` exists: tell user to `cp .env.example .env`
   and set `VITE_ANTHROPIC_API_KEY=sk-ant-...` (or they can paste the key directly
   into the app's sidebar at runtime — it saves to localStorage instead).
4. Run `npm run dev` in background (this is a long-running dev server — do not
   block on it).
5. Report: app serves at `http://localhost:3000`. Note it's a separate process
   from the main monorepo's `npm start` (also port 3000) — don't run both at once,
   check first with `lsof -i :3000` if unsure what's already bound there.

## Mode 2 — GENERATE (draft the ticket yourself, no app/API key needed)

Trigger: any feature/requirement description asking for a CAB JIRA ticket, same
shape as filling the app's form (Title, Objective, Context, NPCI Circular,
Systems Impacted, Transaction Types, Instruments, Current/Expected Behavior,
Key Logic, Risks).

You are the LLM — draft the markdown directly. Do **not** call the Anthropic API
or any tool; this mirrors what `JiraAgent.jsx`'s `SYSTEM_PROMPT` asks the model
to do, just run by you instead of a fetch() call.

### Inputs (ask only for what's missing/relevant)
- JIRA Title
- Objective / Problem Statement
- Context / Background
- NPCI Circular (if any)
- Systems Impacted (UPI Switch, Compliance, PMS, Refund, Recon, Payout/M2P, TPAP/PSP)
- Transaction Types (P2P, P2M, Collect, Intent, Mandate...)
- Instrument Types (Savings, RuPay CC, eRUPI, Wallet...)
- Current Behavior / Expected Behavior
- Key Logic / Rule Change
- Known Risks
- Sub-JIRAs wanted per impacted system? (yes/no)
- **Parent JIRA** (only relevant if the user asks to actually create/file this, not pure GENERATE-in-chat) — if not explicitly given, default to `TSP-5175` (https://finmate.atlassian.net/browse/TSP-5175). Never ask for this — only override when the user names a different parent.

Don't block hard on all fields — Title + Objective is the app's own minimum bar;
proceed with `[TBD]` for anything else genuinely unknown.

### Output — ALL 18 sections, fully populated, never a placeholder heading

Persona: Senior PM + Technical Architect for UPI payment systems, NPCI
regulations, fintech infra (Switch, PMS, Compliance, Refunds, Reconciliation,
Payouts, TPAP/PSP). Use real fintech terminology (ReqPay, ReqAuth, IIN, PSP,
TPAP, MCC, U16, SR, NPCI circulars). Think like a Switch engineer, Compliance
auditor, Recon lead, and Risk owner simultaneously. Clean markdown, `##`/`###`
headers, tables, code blocks for IF-ELSE logic.

```
## 1. 🏷️ Title
## 2. 🎯 Objective / Problem Statement
## 3. 📋 Background / Context
## 4. 📐 Scope of Change (In-Scope ✅ + Out-of-Scope ❌)
## 5. ⚙️ Functional Changes
   ### 5.1 High-Level Flow (Before vs After table)
   ### 5.2 Transaction Processing Behaviour Table
   ### 5.3 Logic Implementation (MANDATORY: full IF-ELSE / decision-tree code block — never prose)
   ### 5.4 API / Field-Level Changes
   ### 5.5 System-wise Changes (one sub-section per impacted system)
## 6. 📊 Impact Analysis (Positive ✅ + Negative/Trade-offs ❌)
## 7. ⚠️ Risk Assessment (table: Risk ID, Type, Description, Probability, Impact, Mitigation — ≥5 rows)
## 8. 🔗 Dependencies (table)
## 9. 📈 Success Metrics & Monitoring (SR impact, failure codes, log lines, dashboard spec)
## 10. 🚀 Rollout Plan (feature flag MANDATORY + phased table with gates)
## 11. 🔙 Rollback Plan (trigger conditions, steps, RTO, RPO — RTO must be defined)
## 12. ✅ Acceptance Criteria / UAT Scenarios (Positive ✅, Negative ❌, Edge ⚠️, Retry/Special 🔁 — min 8 TCs)
## 13. 👤 User Stories (min 3, across compliance/PSP/recon perspectives)
## 14. 🧾 Reconciliation Impact
## 15. 📜 Compliance / Regulatory Alignment (table)
## 16. ❓ Open Questions (table: question, owner, due date, status)
## 17. 📎 References / Annexure
## 18. 📖 Terminology Table
```

Rules (match the app exactly):
- Section 5.3 MUST be an actual IF-ELSE/decision-tree code block, never prose.
- Risk table ≥5 rows, each with probability + mitigation.
- UAT covers all 4 case types (positive/negative/edge/retry).
- Feature flag mandatory in rollout plan; rollback RTO always defined.
- UPI/NPCI-specific terminology throughout — never generic SaaS language.
- Tag anything genuinely invented/unconfirmed as `[TBD]`.

### Sub-JIRAs (only if requested, max 4, one per impacted system)

Per system, shorter format:
```
## Title
## Summary (3-5 sentences)
## Technical Changes (bullets)
## Acceptance Criteria (5-8 bullets, testable)
## Dependencies (on other sub-tasks/systems)
## Risks (2-3, system-specific)
## Effort Estimate ([S/M/L/XL] + reasoning)
```

### Delivery

Output the markdown directly in chat (or CLI stdout). Offer to save as
`~/prd-agent/JIRA-agent/output/<slug>_<timestamp>.md` if user wants a file, or
mention they can paste it into `/jiragenerator` to actually create it in Jira
(that skill writes to Jira via the backend; this skill is draft-only, matching
the standalone app's Copy/Export-only behavior — it never calls a Jira API).

If the user explicitly asks THIS skill to file the ticket (not just draft it),
follow `/jiragenerator`'s own Step 6/6a for the actual create + parent-link call
— same default Parent JIRA (`TSP-5175` if none given), same fallback from
`parent` field to a `Relates` issue-link when Jira's hierarchy rejects a direct
parent (e.g. filing an Epic under a Story-level parent).

---

## Notes / boundaries

- This skill never calls `mcp__prd-agent-tools__jira_create_issue` or any Jira
  write API — GENERATE mode is pure drafting, same as the app's own Copy/Export
  buttons. If the user wants it actually created in Jira, point them at
  `/jiragenerator` for that step.
- LAUNCH mode never edits `JiraAgent.jsx`/`package.json`/etc. — read-only run.
- Don't confuse with `prd-agent/src/jira-agent.jsx` (the JIRA tab inside the main
  monorepo React app on the same port 3000) — different codebase, different
  process, both happen to default to port 3000.

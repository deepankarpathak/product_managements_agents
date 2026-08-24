---
description: Generate a production-ready JIRA ticket (+ optional sub-tasks) for UPI/fintech features, straight from Claude chat/CLI — no browser needed. Mirrors the JIRA Agent (localhost:3000 → JIRA tab) logic, drafted by Claude itself and created via the local backend's Jira credentials.
argument-hint: feature description, optionally with project key, e.g. "TSP: retry policy for UDIR refund callbacks"
---

When user runs `/jiragenerator [description]`:

## 0. Preflight

Call `mcp__prd-agent-tools__check_agents_health`. If backend (port 5000) is down, tell user to run `npm run start:backend` (or `letsbegin` MCP tool) from `prd-agent/` and stop — do not proceed without it, since ticket creation goes through the backend's configured `JIRA_EMAIL`/`JIRA_TOKEN` (`.env`), same as the web JIRA Agent.

## 1. Gather inputs

Collect, asking only for what's missing from `$ARGUMENTS`/conversation:
- **Feature / ticket title** — short name
- **Project keys** — always both `TSP` and `TPAP` boards, unless user explicitly says to file in only one. Never ask for this.
- **Requirement / context** — the actual ask; if user gives a reference JIRA key instead, call `jira_get_issue` to pull its summary/description/AC into context
- **Issue type** — always `Epic`, unless user explicitly says otherwise. Never ask for this.
- **Parent JIRA** — if the user doesn't explicitly give one, default to `TSP-5175` (https://finmate.atlassian.net/browse/TSP-5175). Never ask for this — only override it when the user names a different parent.
- **Sub-tasks wanted?** — yes/no

## 2. Clarify (skip if requirement is already detailed)

Draft a 2-3 sentence objective and up to 4 targeted, implementation-relevant questions, same bar as:

> You are a JIRA delivery lead for UPI/fintech systems. Given the requirement, produce a concise objective and targeted, non-redundant, implementation-relevant clarifying questions.

Ask the user; fold answers back into context. Don't loop more than once.

## 3. Draft the ticket body yourself

Write the ticket markdown directly (you are the LLM — do not call `/api/generate`, that would just be routing your own job through the backend). Use this exact structure, same as the web agent's system prompt:

```
# <Concise, action-oriented title>

## Summary
2-4 bullets: what changes, why now, primary business/tech outcome.

## Objective
Clear goal statements (bullets).

## Problem Statement
User/system pain, current gap, impact if not done.

## Scope
### In scope
Bullets.
### Out of scope
Bullets.

## Functional requirements
| Requirement | Details | Acceptance hint |
(min 4 rows)

## Technical notes
APIs, states, configs, integrations (bullets + short table if useful).

## Dependencies
| System / team | Dependency |

## Risks
| Risk | Impact | Mitigation |

## UAT scenarios
| ID | Scenario | Expected |

## Rollout & rollback
Bullets: flags, phases, rollback trigger.

## Success metrics
Measurable KPIs (bullets).
```

Rules: tag anything invented/unconfirmed as `[TBD]`. Be concise but implementation-ready. Show the draft to the user before creating anything.

## 4. Sub-tasks (only if requested)

Break the parent into 3-8 child items, each shippable by one team where possible, imperative summaries (max 120 chars), self-contained markdown descriptions that reference the parent. Show the list to the user.

## 5. Confirm before writing to JIRA

Creating a ticket is visible to the whole team and hard to fully undo — **always show the final draft (and sub-tasks, if any) and get explicit user go-ahead before calling a create tool.** If the user asks for edits, revise and re-confirm.

## 6. Create

Create the Epic once per board (`TSP` and `TPAP`, both by default) — same title/description on each unless the user asked for board-specific differences:
- No sub-tasks: call `mcp__prd-agent-tools__jira_create_issue` with `projectKey`, `summary`, `description` (the markdown), `issueType: "Epic"` — once per project key.
- With sub-tasks: call `mcp__prd-agent-tools__jira_create_with_subtasks` with `projectKey`, `parentSummary`, `parentDescription`, `parentIssueType: "Epic"`, `subtasks: [{summary, description}]` — once per project key.
- If a project requires extra fields (e.g. TSP requires `duedate` and the cascading `Work Category & Sub Category` custom field), that call will 400 with the exact missing field names — pick sensible defaults (due date from the rollout plan if stated, else a reasonable near-term date; category from context) and retry via the Atlassian MCP `createJiraIssue` tool's `additional_fields`, then tell the user what you defaulted so they can correct it.

## 6a. Link to Parent JIRA

For each board's new Epic, attach it to its Parent JIRA (resolved in Step 1 — user-given, or `TSP-5175` default for TSP; for TPAP, use the same parent only if it's reachable from that board, otherwise skip parent-linking for TPAP and just report the standalone Epic key):
- Try setting `parent` on the new issue (Atlassian MCP `editJiraIssue`, `fields: {parent: {key: PARENT_KEY}}`). This only works when the new issue's type sits directly one level below the parent's in the project's issue-type hierarchy, and when both issues share a project (cross-project `parent` typically errors even at matching hierarchy levels).
- If that call errors (e.g. `"Given parent work item does not belong to appropriate hierarchy"`, or cross-project rejection) — fall back to `mcp__e8cba8d5-f96c-46b4-88b7-6ead354c5ba0__createIssueLink` with `type: "Relates"`, `inwardIssue: PARENT_KEY`, `outwardIssue: NEW_KEY`. Tell the user it's linked via "Relates to" instead of true parent, and why.

## 7. Report

List both created Epic keys and browse URLs (TSP and TPAP) from the tool responses, and how each was linked (parent vs Relates). If any sub-task or board creation failed, call it out by summary (the tool returns per-item errors, not just an overall failure).

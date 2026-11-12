# knowledge/scripts/INDEX.md

**Purpose:** Reusable analysis and output runners — scripts that pull data, build tickets, rebuild decks, or otherwise produce artifacts. One folder per tool with a README and the script(s).

**Distinct from `custom-scripts/`** at the workspace root, which holds framework infra/connection scripts (Trino/Atlassian/Google connectors, MCP setup). Anything that touches a data source, an external surface, or a deliverable belongs here.

---

## Promotion criteria (when a script earns a folder here)

- Script has been run more than once and will be run again
- Script has a clear input / output contract (declared in its README)
- Script produces a file or result the PM would want to reproduce
- Script's purpose is **not** infra/connection (those go to `custom-scripts/`)

One-off scripts written during a single analysis stay in conversation and evaporate. They do NOT get auto-saved here. Promotion is a deliberate `/document-update` action — the PM (or `/document-update`'s audit step) decides a runner is reusable.

---

## Required README frontmatter (per tool folder)

```yaml
---
tool: <slug>
purpose: <one line>
sources_touched: [pulse, olap, ...]   # data sources this script reads/writes
external_surfaces: [jira, slides, ...]  # external surfaces this script writes to
originally_used_in: <session file or first PR>
last_run: YYYY-MM-DD
---
```

Frontmatter is the declarative answer to "is this script relevant to my current task?" — without it the folder is just a code dump.

---

## Tools

No tools yet — promoted via `/document-update` when a script earns reuse value.

---

## When `/document-update` adds a new tool here

- PM has run a script ≥2 times in a session, OR explicitly asks to save it for reuse
- `/document-update` (audit phase) detects a Phase 2 query script that produced a finding worth re-pulling later
- A new external surface (e.g. Notion, Linear) gets a script wrapper

The PM is always asked before promotion — auto-save is forbidden. One-shot scripts stay in conversation.

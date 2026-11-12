# custom-scripts/INDEX.md

**Purpose:** Framework infra and connection scripts — patterns for connecting Claude / Claude Code / external tools to common PM surfaces. **Not** for analysis runners or output scripts (those live in `knowledge/scripts/`).

**Charter:** scripts that help PREMIUM run, not scripts that produce analysis outputs.

---

## What belongs here

- Connection methodology + credential hygiene for a category of tool (warehouses, ticket systems, Google Workspace)
- Reusable connection helpers (e.g. `trino-connect/trino_connect.py` reading creds from Keychain) — the helpers that **other** scripts import
- MCP server activation guides
- Cache, auth, and repo-access utilities

## What does NOT belong here

- Data-pull / analysis runners → `knowledge/scripts/funnel-pull/` (and similar)
- JIRA-creation scripts → `knowledge/scripts/jira-ticket-scripts/`
- Slide / deck builders → `knowledge/scripts/slides-rebuild/`
- One-shot scripts written during a single investigation → stay in conversation, evaporate

If a script is product-specific or produces a deliverable, it belongs in `knowledge/scripts/`. See `knowledge/scripts/INDEX.md`.

---

## Connection Methodologies

Reusable patterns for connecting to common PM tools. Each folder has a README with methodology, credential hygiene, and gotchas. No credentials are committed.

### `google-workspace-connect/`
**What it does:** Template + methodology for connecting Python scripts to Google Sheets / Drive / Gmail. Covers service-account vs OAuth-user choice, creates sheets owned by the PM, and includes a DNS workaround for corporate networks that block `oauth2.googleapis.com`.
**Read first:** `google-workspace-connect/README.md`
**Template:** `connect-template.py`

### `data-warehouse-connect/`
**What it does:** Methodology for connecting Python scripts to a SQL data warehouse (Trino / Starburst / Snowflake / BigQuery / Postgres). Credential hygiene (Keychain, .env, vault), connection script pattern, dialect gotchas.
**Read first:** `data-warehouse-connect/README.md`

### `atlassian-connect/`
**What it does:** Methodology for JIRA / Confluence access. Two methods documented: REST API + API token (reliable, scriptable) and MCP (nicer UX when reachable). Python script pattern for common operations (get / create / update ticket).
**Read first:** `atlassian-connect/README.md`

### `mcp-server-setup/`
**What it does:** Guide for activating MCP servers in Claude Code (Figma, Slack, Atlassian, Google Drive, etc.). Step-by-step auth flow, network gotchas, common failure modes, when NOT to use MCP.
**Read first:** `mcp-server-setup/README.md`

### `trino-connect/`
**What it does:** Trino/Starburst connection helper reading creds from macOS Keychain (`paytm-trino`). Exposes `run_query(sql)` returning a list of dicts. Used by analysis runners in `knowledge/scripts/`.
**How to use:** `from trino_connect import run_query`
**Read first:** `trino-connect/README.md`

---

## When to Add a Script Here

- The script is an infra/connection helper that other scripts will import
- The script is a methodology guide for connecting to an external tool category
- The script is workspace-agnostic (would apply to a different PREMIUM product if it existed)

If the answer is "no" to all three, it does NOT belong here. Route to `knowledge/scripts/` or keep in conversation.

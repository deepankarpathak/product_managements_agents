# knowledge/INDEX.md

**Purpose:** Routing table for all knowledge in this workspace. `/document-update` reads this file to classify discoveries and route them to the right target.

**Rule:** Every entry MUST have both **Contains:** and **Update when:** lines. Entries without both are invalid and must be fixed before any skill run.

---

## Status

Unpopulated. `/onboard` fills this in on first run, based on the PM's product context and data sources.

---

## Format (template for /onboard to follow)

```
## <file or folder name>
**Contains:** <one-line description of what's stored here>
**Update when:** <one-line description of the trigger to add to this file>
```

### Example entries (illustrative — replace during /onboard)

```
## product-context.md
**Contains:** Product journey, users, flows, behavioral insights
**Update when:** You learn something new about how the product works, user segments, or behavior patterns

## data-sources/
**Contains:** Per-source connection, schema, queries, gotchas
**Update when:** New column, new query, tool quirk, auth change
**Sub-INDEX:** See data-sources/INDEX.md

## errors/mapping.md
**Contains:** Error code → user message mappings
**Update when:** New code discovered, or meaning of existing code corrected

## screens/
**Contains:** Screenshots / HTML captures of product screens
**Update when:** New screen, or existing screen changed meaningfully

## competitors/
**Contains:** Competitive analysis — one folder per competitor
**Update when:** You find how a competitor handles the same flow

## reference/
**Contains:** Original source documents the PM provided (PRDs, research, architecture, decks, notes)
**Update when:** PM shares a new source document to extract knowledge from; or an existing doc is superseded
**Sub-INDEX:** See reference/INDEX.md

## scripts/
**Contains:** Reusable analysis and output runners — data pulls, deck builds, JIRA submitters. One folder per tool. Distinct from workspace-root `custom-scripts/` which holds infra/connection helpers only.
**Update when:** A script is run ≥2 times and PM wants reuse, or `/document-update` audit detects a query worth promoting. PM approval required.
**Sub-INDEX:** See scripts/INDEX.md
```

---

## When Nothing Fits

If a discovery doesn't match any **Update when** above, `/document-update` will:
1. Propose creating a new category
2. Ask PM to approve name + file structure
3. Add a new entry here (with mandatory Contains + Update when lines)
4. Create the folder + stub file

Do NOT force-fit discoveries into an existing category if they don't match. Create a new category.

---

## Sprawl Guardrail

If this INDEX exceeds 10 top-level entries, `/document-update` warns the PM. Hard limit: none. Soft guidance: consolidate before adding more.

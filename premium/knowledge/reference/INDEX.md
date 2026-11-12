# knowledge/reference/INDEX.md

**Purpose:** Original source documents the PM provided — PRDs, research reports, architecture diagrams, spec docs, slide decks, meeting notes, spreadsheets. These are raw inputs we extract structured knowledge from; the originals stay here for lookup.

**Status:** Populated during `/onboard` (when PM shares docs) and by `/document-update` whenever the PM shares new reference material mid-session.

---

## Format

| File | Type | Received | Summary | Extracted into |
|---|---|---|---|---|
| _example: product-prd-v2.pdf_ | _PRD_ | _2026-04-20_ | _Product requirements for v2 — user segments, feature list, metrics_ | _product-context.md, data-sources/<source>/schema.md_ |

Registry is empty on fresh clone. Every source document added here gets a row.

---

## Rules

1. Save originals with descriptive filenames — not `document (1).pdf` or `scan.jpg`
2. Every file physically present in `reference/` must have a row here — no orphans
3. If a document is superseded by a newer version, mark the older `[archived]` in Summary; keep both files
4. Keep `Type` values consistent: `PRD`, `Research`, `Architecture`, `Deck`, `Notes`, `Spreadsheet`, `Other`
5. `Extracted into` ties a source back to the structured knowledge it produced — future sessions can trace "where did this fact come from?"

---

## Update when

- PM shares a source document during `/onboard`
- PM drops a new reference doc mid-session (research update, fresh PRD, new architecture diagram)
- An existing document is superseded

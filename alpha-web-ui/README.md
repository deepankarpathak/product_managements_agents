# UPI Alpha — Web UI

A beautiful web front-end for the UPI Alpha knowledge base. Ask product
questions in a browser and they're answered by your **local Claude Code** —
with the full repo loaded (CLAUDE.md, every skill, all MCP servers, trino,
figma, the wiki and raw sources). **No API key required**; it uses your
existing Claude Code login, exactly like `scripts/ui-design-server.py`.

## How it works

The Next.js server spawns the `claude` CLI with its working directory set to
the UPI Alpha repo root:

```
claude -p "<your question>" \
  --output-format stream-json --verbose --include-partial-messages \
  --dangerously-skip-permissions --model opus \
  --session-id <uuid>            # first turn
  --resume <uuid>                # follow-up turns
```

Streamed JSONL events are relayed to the browser over SSE, so you see the
answer **and** every tool call (search.py, trino queries, wiki reads…) live,
just like the terminal.

## Features

- **Overview** — the landing tab: an at-a-glance intro to the product, every
  agent/skill (query, figma, dashboard, PRD, circular, …) in one line each, and
  the live integrations.
- **Ask** — streaming chat with live tool-call cards, model picker
  (Opus / Sonnet / Haiku), skill chips for every `/command`, and a usage-limit
  banner.
- **Dashboards** — a gallery of every chart/dashboard we've built (from
  `~/Documents/Claude_Charts/`): PNG charts, HTML dashboards (rendered live),
  and CSV/MD, with a full-size lightbox.
- **Wiki** — browse and read the synthesized `wiki/` (rendered markdown).
- **Raw data** — browse `raw/` with markdown / CSV-table / image / text
  viewers.
- **Upload** — drag-drop new source files into any folder under `raw/`
  (add-only — never overwrites existing sources).
- **Design** — a full interactive design studio embedded in the app: live
  prototype preview in selectable device frames (mobile/tablet/desktop/full +
  rotate), edit any `prototypes/*.html` by chatting in plain English, **upload
  screen screenshots** as visual references (Claude reads them and matches the
  design), and create brand-new screens from a screenshot. A one-tap
  **Replace with screenshot** button rebuilds the current screen to match an
  uploaded image (no typing). The model writes the HTML file directly and the
  preview reloads.

## Run it

```bash
cd web-ui
npm install        # one-time
npm run dev        # http://127.0.0.1:3000
```

Prerequisites: the `claude` CLI installed and logged in (`claude` works in your
terminal), and Node 18+.

## Security notes

- The dev/prod servers bind **127.0.0.1 only**. The chat endpoint runs the
  `claude` CLI with `--dangerously-skip-permissions` (full tool access, like
  your terminal), so it must never be exposed to a network. Do not change the
  host binding to `0.0.0.0`.
- File browsing is confined to `wiki/` and `raw/`; uploads are confined to
  `raw/` and refuse to overwrite.

## Notes

- `node_modules` is symlinked off Google Drive
  (`~/.cache/upi-alpha-web-ui/node_modules`) to avoid sync thrash from ~30k
  dependency files. Re-create the symlink with
  `ln -sfn ~/.cache/upi-alpha-web-ui/node_modules web-ui/node_modules` if you
  move the repo. (`.next` is a normal local folder — Next's production build
  needs it co-located with `node_modules`.)
- This app **reads** the repo and **adds** uploads to `raw/`. It never edits
  existing repo files — chat actions follow the same CLAUDE.md rules as the
  terminal.

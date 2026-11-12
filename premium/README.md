# PREMIUM (Framework Template)

This is the PREMIUM framework template. Clone this repo when you are setting up a new product analysis workspace. For a fully worked example of what this template looks like once populated, see `bitbucket.org/paytmteam/premium-fastag`.

## What is PREMIUM

PREMIUM is a framework that turns Claude Code into a structured product-analysis partner. Instead of asking Claude open-ended questions and hoping for useful answers, you invoke named workflows (skills) that follow a fixed shape: frame the question, pull the data, test the hypothesis, persist the artifact. The result is that two PMs running the same investigation produce the same shape of output, the work is reproducible, and the framework's memory grows over time.

This repo is the clean Layer 1 template. It contains the framework itself: the skills, the sub-agents, the rules, and the empty scaffolding for knowledge and artifacts. It does NOT contain product-specific content (no FASTag, no Mobile, no CCBP); the worked FASTag example lives in a separate repo at `bitbucket.org/paytmteam/premium-fastag`.

Cloning this repo gets you:

- A battle-tested skill set: seven named workflows for funnel exploration, hypothesis investigation, decision framing, and JIRA shipping, all with explicit phases and exit gates.
- A knowledge-base scaffold: typed folders for data sources, error mappings, screen references, competitor comparisons, and reusable scripts, ready to be filled in for your product.
- Agent infrastructure: two pre-wired Haiku sub-agents (`schema-reader`, `knowledge-updater`) and four rules that keep Claude on-voice and on-process across every turn.

> **First time here?** Once you have cloned this repo and opened Claude Code in it, your next step is to run `/onboard`. It populates Layer 2 of `CLAUDE.md` and seeds the knowledge structure with your product's specifics (data sources, key events, error taxonomy). After that, the workspace is ready for `/explore`.

## How it works (the mental model)

Before you touch any folder, hold five concepts in your head. They're the entire mechanism.

### 1. Claude Code is the engine

You don't open PREMIUM directly. You open Claude Code, which is Anthropic's CLI / desktop / web app that runs Claude with file-system access. Think of it as Claude with hands: it can read files in this folder, write files, run scripts, call APIs.

When you start a session, Claude Code opens a working directory (this folder). Everything Claude does happens here.

### 2. CLAUDE.md is the workspace manual, loaded automatically

In the root of every PREMIUM workspace there's a file called `CLAUDE.md`. Claude Code reads this file the moment you start a session, before you type anything. It's the workspace's manual: what this repo is, what conventions to follow, where the knowledge lives, what skills exist, what to do at boot.

You can think of it as the system prompt you'd otherwise have to paste every time. PREMIUM puts it on disk so it's versioned, editable, and consistent across the team.

When you change `CLAUDE.md`, the change applies to the next session you start. It doesn't retroactively affect a session that's already running.

### 3. A session is one continuous conversation with state

Every time you start chatting with Claude in this workspace, you're in a session. A session has:

- A transcript: every turn (yours + Claude's) is saved to disk
- A context window: Claude holds the recent conversation in active memory (roughly 200K tokens worth)
- A `<CURRENT_SESSION>` pointer: the session log file that captures what happened (`sessions/YYYY-MM-DD-<slug>.md`)

When context fills up, Claude Code auto-compacts: it summarizes the older parts of the conversation and replaces them with the summary. This is silent in some UIs and visible in others (PREMIUM's UI shows a `⟳ SESSION COMPACTED` marker). Your transcript on disk is untouched, only the active in-memory context is compressed.

After compaction, Claude still knows what happened, but at a coarser grain. This is why persistent artifacts matter: anything saved as a file survives compaction; anything that only lived in the chat does not.

### 4. Skills are named workflows, not freeform chat

PREMIUM doesn't ask you to figure out how to analyze a funnel from scratch each time. Instead, it gives you skills, which are named, phased workflows Claude knows how to execute end-to-end. You invoke a skill by typing `/<skill-name>` or by describing the goal in natural language (Claude will route to the right skill via the framework's trigger rules).

A skill is not a function call. It's a state machine. Each one has explicit phases (Frame, Plan, Test, Conclude, Persist), exit gates between phases, and a set of output files it MUST produce before terminating. This is what makes Claude's work reproducible: every `/explore` run produces the same shape of artifact, no matter who runs it.

Example: `/explore` always produces a `## File outputs` table containing a report, a hypothesis file per finding, a per-run data folder with provenance sidecars, and an entry in `artifacts/INDEX.md`. You don't have to remember any of that. The skill enforces it.

### 5. Knowledge teaches Claude; artifacts are what Claude makes

Two kinds of files in this repo, with very different roles:

- Knowledge files (in `knowledge/`) are what you've taught Claude about your product: data schemas, error mappings, product context, screen captures, past research. Claude loads them on demand when a skill needs them. You curate these carefully; they're the framework's long-term memory.
- Artifacts (in `artifacts/`) are what Claude produces for you: hypothesis files, investigations, reports, data dumps, dashboards. They accumulate as you work. Each one has frontmatter linking it back to its parent skill run, the data files behind it, and any related artifacts.

The asymmetry matters: knowledge is the input, artifacts are the output, sessions are the log of what happened in between.

### Putting it together

```
   YOU
    │
    ▼
┌─────────────────────────────────────────────┐
│ Claude Code (the engine, runs in a session) │
│                                             │
│   reads:  CLAUDE.md (workspace manual)      │
│           knowledge/ (what you've taught)   │
│                                             │
│   runs:   skills (named workflows)          │
│                                             │
│   writes: artifacts/ (output)               │
│           sessions/<CURRENT_SESSION>.md     │
│           (the log of what happened)        │
└─────────────────────────────────────────────┘
```

That's the whole mechanism. The rest of this README is the tour: what each folder contains, when each skill fires, and how the team uses all of it together.

## The 7 skills (when to use each)

There are five skills in the main analytical flow, plus two utilities. You'll use most of them on a typical week.

| Skill | Use when | Output |
|---|---|---|
| `/onboard` | You're setting up a new product workspace for the first time and need Claude to learn the basics: data sources, schemas, key events, error taxonomy. | A populated Layer 2 section in `CLAUDE.md`, plus seeded `knowledge/data-sources/INDEX.md` and `knowledge/INDEX.md`. |
| `/explore` | You want to understand a funnel, a drop-off, a cohort, or "where is the leak". You don't have a hypothesis yet; you're hunting for one. | An explore report in `artifacts/reports/`, one hypothesis file per finding in `artifacts/hypotheses/`, raw data + sidecars in `artifacts/data/<run>/`, and an `artifacts/INDEX.md` entry. |
| `/investigate` | You already have a hypothesis (yours or one `/explore` surfaced) and you want to test it against the data. | An investigation file in `artifacts/investigations/`, plus a status flip on the parent hypothesis (SUSPECTED to CONFIRMED, DISPROVED, or INCONCLUSIVE). |
| `/decide` | You have a validated hypothesis and need to figure out what to actually do about it: options, tradeoffs, expected impact. | A decision doc in `artifacts/reports/` with solution options scored. |
| `/ship` | You're ready to file a JIRA ticket and want Claude to draft it using the linked artifacts as context. | A JIRA ticket draft (saved under `jira/details/` and listed in `jira/tickets.md`). |
| `/discuss` | Quick question or single data pull. Four sub-modes: Lookup (just answer), Relate (link an artifact to others), Reflect (think about a decision), Pull (one-shot data fetch). | An answer in chat. Pull mode also saves the dataset to `artifacts/data/` with a provenance sidecar. |
| `/document-update` | End of session, or any moment you want to crystallise what was learned into long-term memory. Also runs a Phase 0 audit to catch missed persistence from earlier skills. | Updates to relevant `knowledge/` files, a session log entry in `sessions/`, and `INDEX.md` refreshes. |

The typical flow is straightforward: `/explore` to find candidate hypotheses, `/investigate` to test the ones that matter, `/decide` to plan a fix, `/ship` to file it. `/discuss` and `/document-update` are utilities you can fire at any point in (or between) those steps.

## Folder tour (what lives where, why, and when you touch it)

A walk through the template tree. Because this is a clean template, most Layer 2 folders are scaffolding: `.gitkeep` placeholders or `INDEX.md` files with the table-of-contents structure but no actual content yet. They get populated by `/onboard` and by your daily work after that.

> If you've already run `/onboard`, many of these folders will be populated. If you've just cloned, they're scaffolds.

### Top-level files

`CLAUDE.md` (framework code + workspace-specific Layer 2): the manual Claude Code reads at session start. Layer 1 (the framework conventions) is shared across all PREMIUM workspaces and you don't edit it; Layer 2 (your product-specific context: data sources, key dates, current focus areas) gets populated by `/onboard` and updated by `/document-update` as you learn. In this template, Layer 2 is a stub waiting to be filled.

`CONTRIBUTING.md` (you read for context): the rules for contributing to this repo. Branching, PR review, commit hygiene. Read before opening your first PR.

`CHANGELOG.md` (auto-managed): tracks framework and workspace changes by version. Don't edit by hand.

`VERSION` (framework code, don't modify): the current PREMIUM framework version. Pinned by the admin team.

`.gitignore` (framework code, don't modify): the standard ignore list for PREMIUM workspaces.

### `.claude/` (framework code, don't modify)

This is the framework's working directory. Claude Code reads it but you should never edit it directly. Framework upgrades flow in from this `premium-main` repo to your product workspace.

`.claude/commands/` holds the seven skill definitions: `onboard.md`, `explore.md`, `investigate.md`, `decide.md`, `ship.md`, `discuss.md`, `document-update.md`. Each file is the full state machine for one skill (phases, exit gates, output contract). If you want to understand exactly what `/explore` is doing under the hood, open `explore.md`. Don't change it; if a skill is misbehaving, file a framework issue.

`.claude/agents/` holds the two sub-agents: `schema-reader.md` (a read-only Haiku agent that fetches schema info cheaply) and `knowledge-updater.md` (a write-only Haiku agent that persists discoveries to `knowledge/`). Skills delegate to these; you don't invoke them directly.

`.claude/rules/` holds the four framework rules: `premium-guardrails.md` (the voice and analytical standards), `skill-triggers.md` (how natural language routes to skills), `turn-classifier.md` (how Claude decides what kind of turn this is), `pivot-handling.md` (what to do when the PM changes direction mid-skill). These load into context on every turn.

### `knowledge/` (you curate)

This is the workspace's long-term memory. Everything in here is something you've taught Claude about your product. Skills load relevant pieces on demand in their Phase 0. In this template, the folder is a scaffold; `/onboard` seeds it and you build it up from there.

`knowledge/INDEX.md` (auto-managed): the catalog of what's in `knowledge/`. Skills read this to discover what knowledge is available.

`knowledge/product-context.md` (you curate): a one-page summary of your product. What it is, who uses it, the user journey at a high level, the business goal. This is what gives Claude the framing for every analysis. In the template it is a placeholder; `/onboard` fills it in.

`knowledge/data-sources/` (you curate): everything Claude needs to write correct queries. `INDEX.md` lists available sources; `REGISTER.md` is the structured catalog of tables, columns, partitions, filters, gotchas. Treat this folder like sacred ground: if a column name is wrong here, every future query is wrong too. `/onboard` populates these files; `/document-update` keeps them fresh as new discoveries surface.

`knowledge/errors/mapping.md` (you curate): your product's external-code to internal-code to user-facing-message mapping (e.g., BBPS codes for recharge products, PG codes for payment products). Grows as you investigate failure modes. `/investigate` and `/explore` both rely on this for error analysis. Empty in the template.

`knowledge/screens/` (you curate): screenshots of your product's screens, named by screen + state. When Claude reasons about user experience, it loads these to ground the analysis in what the user actually sees. Empty placeholder (`.gitkeep`); add screens as you capture them.

`knowledge/competitors/comparison.md` (you curate): how your product stacks up against its alternatives. Updated when you do competitive analysis. Used by `/decide` to benchmark proposed solutions.

`knowledge/reference/` (you read for context, sometimes curate): the deep-research library. Each file is a long-form analysis: problem definitions, funnel opportunity maps, journey narratives, prior investigations that pre-date PREMIUM. `INDEX.md` lists them. Empty in the template; import any pre-existing research here when you set the workspace up.

`knowledge/scripts/` (you curate): reusable Python or SQL scripts that don't belong to a single skill run. `INDEX.md` catalogs them. If you write a script during an investigation that you'll likely re-use, save it here.

### `artifacts/` (auto-managed by skills)

Everything Claude produces lands here. You don't write to this folder by hand; skills do. In the template, every subfolder is a `.gitkeep` placeholder; they fill up as you run skills.

`artifacts/INDEX.md` (auto-managed): the typed registry of every artifact, what skill produced it, when, and what it's linked to. This is your map. In the template, all sections are empty and waiting.

`artifacts/hypotheses/` (auto-managed): one file per hypothesis. Frontmatter tracks status (SUSPECTED, CONFIRMED, DISPROVED, INCONCLUSIVE, PARKED) and links to the explore that surfaced it and any investigations that tested it.

`artifacts/investigations/` (auto-managed): one file per `/investigate` run. Contains the test plan, queries, evidence, and verdict. Each one updates its parent hypothesis's status.

`artifacts/reports/` (auto-managed): the longer narrative outputs from `/explore` and `/decide`. Explore reports summarize what was found across a funnel; decide reports lay out solution options.

`artifacts/data/` (auto-managed): per-run data folders. Every skill that pulls data writes to a subfolder named after the run, with each data file accompanied by a sidecar `.md` containing provenance (query, date, source, filters). Survives compaction; this is your durable evidence trail.

### `sessions/` (auto-managed by skills)

One file per session. Named `YYYY-MM-DD-<slug>.md`. The session log captures the narrative of what happened: what the PM asked, what Claude figured out, what was decided, what got persisted where. Compaction-safe: written to disk as the session progresses. Empty in the template (just a `.gitkeep`); your first session creates the first file.

### `custom-scripts/` (you read for context; framework provides templates)

The integration glue between PREMIUM and the rest of Paytm's stack. Each subfolder has a `README.md` explaining what it connects to and how.

`custom-scripts/INDEX.md` lists everything. The connectors: `trino-connect/` (Trino queries via Python), `data-warehouse-connect/` (broader DWH access), `atlassian-connect/` (JIRA + Confluence), `bitbucket-connect/` (git operations), `google-workspace-connect/` (Drive + Sheets + Calendar, plus a `connect-template.py`), `mcp-server-setup/` (the MCP server configs that wire it all into Claude Code).

Most users won't touch these directly. They get configured once during onboarding by the platform admin (talk to Apekshit or Anuj). If a query fails with a connectivity error, this is where you look.

### `jira/` (auto-managed by `/ship`, you read for context)

`jira/tickets.md` (auto-managed): running ledger of tickets created from this workspace. One row per ticket: ID, title, status, link to the hypothesis or investigation that drove it. Empty in the template.

`jira/details/` (auto-managed): the longer-form ticket drafts produced by `/ship`. Each file is the full text of a ticket as it was filed, kept for traceability. Empty placeholder (`.gitkeep`); fills up once you start shipping.

That's the whole template. Clone it, open Claude Code in the new folder, and run `/onboard` to bring it to life for your product.

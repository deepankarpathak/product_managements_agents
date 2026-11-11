# prd-agent — UPI PM Agent Suite

Internal monorepo with six AI agents for the Paytm UPI product team. All agents share one Node.js backend and a single React UI at `http://localhost:3000`.

| Agent | Tab | Purpose | Source |
|---|---|---|---|
| PRD Agent | PRD | Production-grade PRDs | `src/prd-agent-v7.jsx` |
| UAT Agent | UAT | UAT sign-off documents | `src/uat-agent1.jsx` |
| BRD Agent | BRD | Business Requirements Docs | `src/brd-agent.jsx` |
| JIRA Agent | JIRA | Draft + create Jira tickets | `src/jira-agent.jsx` |
| Analyst Agent | Analyst | Natural language → Trino SQL | `Query_Agent/` (Next.js, port 3040) |
| **α Alpha Agent** | α Alpha | UPI intelligence chat (wiki + queries + schema) | `src/alpha-agent.jsx` |

---

## Architecture

```
prd-agent/
├── src/                    React frontend (CRA, port 3000)
│   ├── App.js              Tab switcher — all agents mount in parallel
│   ├── prd-agent-v7.jsx    PRD agent
│   ├── uat-agent1.jsx      UAT agent
│   ├── brd-agent.jsx       BRD agent
│   ├── jira-agent.jsx      JIRA agent
│   ├── alpha-agent.jsx     Alpha Agent (UPI intelligence chat)
│   ├── analyst-agent.jsx   Analyst iframe wrapper
│   ├── pm-home.jsx         Today (#today)
│   ├── product-dashboard.jsx  Product Wise (#product)
│   └── apd-toggle.jsx      Automatic Payments on / off switch
├── backend/
│   ├── server.js           Express 5 ESM backend (port 5000)
│   │   ├── /api/generate   Main LLM route (PRD/UAT/BRD/JIRA)
│   │   ├── /api/claude     Direct Anthropic/Foundry route (BRD)
│   │   ├── /api/alpha/chat Alpha Agent chat (UPI wiki + LLM)
│   │   ├── /api/jira/*     Jira CRUD
│   │   ├── /api/share/*    Publish (Jira/Email/Slack/Telegram)
│   │   └── /api/score      Document quality scoring
│   ├── productDashboard.js Product Wise (/api/product/*): queries, as-of, backfill
│   ├── dayStore.js         Per-day cache files for all dashboards
│   ├── ccCasaCompare.js    CC vs CASA before / after + Excel
│   ├── codeParty.js        Failure-code party (APD rules)
│   ├── apdRunner.js        Legacy Automatic Payments page + on / off switch
│   ├── reference/apd-sql/  Copies of the APD SQL used by Product Wise
│   └── data/               Local caches (gitignored)
├── Query_Agent/            Analyst Agent (Next.js 15, port 3040)
│   ├── app/                Next.js App Router
│   ├── components/
│   │   └── query-agent.tsx Main chat UI
│   └── lib/
│       ├── config.ts       Schema + reference root env vars
│       └── reference-index.ts  BM25 search over .sql/.md files
├── mcp/
│   └── agents-launcher/    MCP server for /letsbegin
│       └── index.js        Starts all stacks + MCPs on /letsbegin
└── scripts/
    ├── start-mcps.sh       Start external MCP servers (kb, redash, prometheus, superset)
    └── live-agent-logs.command  macOS Terminal — tail all 7 log files
```

---

## SR dashboards

Success-rate dashboards share the same backend and UI. They query the DWH (Trino) and, for short windows, the live switch DB via Redash. Results are cached per day under `backend/data/` (gitignored; see [Storage and history](#storage-and-history)). Product Wise, Today and the other monitoring pages are under [Product Wise and monitoring](#product-wise-and-monitoring).

| Tab | Hash | Purpose | Source |
|---|---|---|---|
| **Unified SR (beta)** | `#srdash` | Merged Morning + Snippet view: sections A–K | `src/sr-unified-dashboard.jsx`, `backend/unifiedDashboard.js` |
| Success Rate Snippet → P2M view | `#srdash?view=p2m` (`#srsnippet` redirects here) | P2M SR snapshot for the 4 TPAP handles, built from the Unified SR cache | `src/sr-snippet.jsx`, `backend/srSnippet.js` |

Unified SR sections:

| Section | Covers |
|---|---|
| A | SR breakdown, impact ranked by PSP, bank, instrument and flow, with a filter bar |
| B | Decline codes: NPCI description, ₹ value, D-1…D-3, top impacted banks |
| C | SR by handle × flow (intraday) |
| D | Error code trend, failures only (TD / BD / RD) |
| E | U09 trend, intraday or 15 days, by payee PSP |
| F | Payer (remitter) bank report: health, contribution, error spikes, hourly DWH bank check |
| G | Payee PSP SR%, success and volume, plus merchants |
| H | Payer instrument SR, including Postpaid / Credit Line |
| I | Txn share by payer handle, OS, instrument and category |
| J | Raw-txn drill-down and sample-transaction download |
| K | Escalation candidates: score, recipient, Minto-style email draft |

Shared modules:

| File | Role |
|---|---|
| `backend/trinoClient.js` | Trino runner with a shared concurrency limiter, plus the Redash runner. Used by every dashboard. |
| `backend/unifiedDrill.js` | `/api/udash/drill/*`: on-demand drill-down, samples, durations |
| `backend/bankReport.js` | Bank report split, error spikes, intraday bank alerts |
| `backend/srAlertMessage.js` | Slack SR alert / daily digest text |
| `src/sr-shared.jsx` | KPI strip, declines table and breakdown views shared by the SR tabs |
| `src/bank-health.mjs` | Bank health v2: shift-share contribution, z-score vs the bank's own σ, 2-day persistence |
| `src/escalation.mjs`, `src/unified-psp.mjs`, `src/unified-scorecard.jsx`, `src/breakdown-*.{mjs,jsx}` | Escalation scoring, PSP mapping, scorecards, breakdown tables |

API: `/api/udash/*` (state, run, config, annotations, drill), `/api/srsnippet/*`, `/api/history/*`. Every run is saved to Dashboard History.

The ☀ Morning Dashboard is retired: Unified SR replaces it, and `#morning` bookmarks open Unified SR. Old Morning runs stay readable in History but can't be re-run. `MDASH_*` env names are still read by `trinoClient.js`.

The Success Rate Snippet is retired as a separate dashboard (11 Nov 2026). It is now the **P2M view** of Unified SR (`#srdash?view=p2m`). `backend/srSnippet.js` builds it from the Unified SR cache (`snippetFromUnified`) and runs no query of its own; Refresh re-runs the Unified sections it reads (breakdown, dims, codes). Set `SRSNIPPET_OWN_QUERY=true` to bring back the old Trino query and its 09:00 / 12:00 schedule. New runs are saved in History under **Unified SR Dashboard**. Old Snippet runs (up to 11 Nov 2026) stay readable in History under "Success Rate Snippet (retired → Unified SR P2M)".

Dashboard History (`#history`, `src/dashboard-history.jsx`, `backend/historyStore.js`) lists every query run, manual and scheduled, for Unified SR, Product Wise and Skills (Utilities), plus old runs of the two retired dashboards. Records are saved as `.md` + `.json` + a per-day `index.jsonl` under `Query_Agent/AnaylsisAgent_output/history/YYYY-MM-DD/`. Pre-select a dashboard with `#history?dashboard=unified|product|skills|srsnippet|morning`.

Relevant env (values in `.env` only): `TRINO_API_URL`, `TRINO_SERVICE_USER`, `TRINO_SERVICE_PASSWORD`, `TRINO_CATALOG`, `TRINO_SCHEMA`, `TRINO_SOURCE`, `TRINO_EXECUTE_AS_USER`, `TRINO_IMPERSONATION`, `MDASH_TRINO_MAX_CONCURRENT` (default 3), `PTYES_REDASH_URL` / `PTYES_REDASH_API_KEY` (or `MDASH_REDASH_*` / `REDASH_*`), `SLACK_WEBHOOK_URL`.

The live switch-DB bank alert (`bankalert`) is **off** by default. The DWH bank check (`bankdwh`) runs hourly.

---

## Product Wise and monitoring

Other monitoring pages in the same UI. Each reads its backend cache; opening a page runs no query.

| Page | Hash | Purpose | Source |
|---|---|---|---|
| Today | `#today` | Home page: one summary card per dashboard (Unified SR, products, Acquiring SR, transaction breakup, data freshness), read from their caches | `src/pm-home.jsx`, `backend/pmHome.js` |
| Acquiring SR | `#acqsr` | Acquiring SR from the PTYBL switch Redash (live slave): recent / any-date SR, daily pattern, 60-day history — see [Acquiring SR](#acquiring-sr-acqsr) | `src/sr-acquiring.jsx`, `backend/acqCollector.js` |
| **Product Wise** | `#product?tab=<id>` | Product tabs, below | `src/product-dashboard.jsx`, `backend/productDashboard.js` |
| Automatic Payments (legacy) | `#autopay` | Embedded APD page (`third_party/apd_installer`); can be switched off, see below | `src/autopay.jsx`, `backend/apdRunner.js` |
| History | `#history?dashboard=unified\|product` | Every query run, with SQL, output and insights | `src/dashboard-history.jsx` |

### Product Wise tabs

| Tab | `tab=` | What it shows |
|---|---|---|
| 🌐 UPI International | `international` | Activation and txn SR by PSP / bank / country, error codes; §7–9 failure deep-dive (20 cuts, RIS mapping, analyst notes, activations not completed); §10 **Explore txns**: txn-level rows, cross-filter any of 23 cuts by clicking a row, min / max amount |
| 🔌 UPI Plugin | `plugin` | Plugin onboarding (users, accounts, VPAs) |
| ⚡ UPI Lite | `lite` | Lite accounts, top-ups, GMV, codes, AutoPay (trends up to 120 days) |
| ↩ UPI Refunds · 💸 Payouts | `refunds` · `payouts` | SR by flow / bank, decline codes, MTD / LMTD |
| 🔁 Mandates | `mandates` | Golden mandate unit (Paytm-app UMNs incl. @paytm, one per UMN per day). §1–2 SR by stage and CC / CASA; §3 failure codes with **Party** (APD rules) and TD / BD, Trend or *Days + 13-day median* view; §4 / 4b where a code fails and what drives it; §5 SR by mode / MCC / payer bank / payee bank / handles (Top 15 / 30 / 40, search, *D-1 … D-14 + median* view); §6 top merchants (D-1 … MTD / LMTD, search); §7 Code watch (UM8-ZM, UM8-Z6, UO8 by mandate type) |
| 🏧 ICCW | `iccw` | Cash withdrawal (MCC 6013, purpose 12 / 13): SR by purpose, acquirer, remitter bank, handle, amount, hour; codes and where they fail |
| 🔀 Interop | `interop` | Update payee VPA, Update MIC, Port-In (purpose BC), Port-Out; till date since 23 Dec 2025 vs chosen days; Custom from–to; "Days as rows" layout |
| 💳 CC vs CASA | `cccasa` | §1–2 P2M SR and failure codes, credit card vs savings / current (day view or 14-day shaded matrix); §3 **before / after a pivot day** (default 7 Oct, RCC) for Autopay + P2M: SR, gap change, code movers with party, day-on-day top codes, **⬇ Excel** (About, Pre vs Post SR, Code movers, All codes, Daily SR, DoD top codes). Autopay CC vs CASA also = Mandates with Payer account CC / CASA |

Controls shared by the tabs:

- **Range**: 1–15 days (live 30-day cache), **30 / 60 / 90 days, MTD, Custom from–to** (read from the saved days). Current period vs the same number of days before. On long Mandates ranges, bank / MCC / handle splits are summed per 7-day block; stage and code rows stay daily.
- **As of** (header): pick a saved day; every section of the tab anchors on it, read-only. Link: `#product?tab=mandates&asof=2026-10-31`. **Latest** returns.
- **Sorting**: click any table header (again to reverse).
- **SQL** on a section: the APD per-table query filled with the current stage / purpose / dates (where one exists), then the per-day pipeline query.
- **Deep links** (Mandates): `&stage=EXECR&purpose=14&mode=04&acct=CC&code=UM3&split=PAYER_BANK&where=HANDLE`.
- Refresh: daily 09:30 IST, one Trino query per day; days older than 2 are reused, so a refresh only re-queries the newest days.

### Storage and history

- Each dashboard section / query is a folder of day files: `backend/data/product/<product>/<query>/` and `backend/data/udash/<section>/` with `meta.json` + `days/YYYY-MM-DD.json` (gzipped after 35 days, never deleted) — `backend/dayStore.js`. All of `backend/data/` is local and gitignored. Do not name a query `days` (it is the day-file folder).
- **Backfill** fills older days into the day files without touching the live cache (resumable, never overwrites a saved day):
  ```bash
  curl -s -XPOST localhost:5000/api/product/backfill -H 'content-type: application/json' -d '{"product":"mandates"}'
  curl -s localhost:5000/api/product/backfill          # progress
  ```
  Sources (`BACKFILL` in `productDashboard.js`): Mandates since 1 Jan via Trino; ICCW (Oct 2025), CC vs CASA P2M (1 Sep), International (15 Sep), Code watch (Aug), top merchants (1 Sep) from the imported APD history.
- **APD history** (`backend/data/product/_apd-history/`): every APD cache imported day by day; re-run with `node backend/scripts/import-apd-history.mjs` (keeps earlier entries if the APD folder is gone).
- APD SQL copies live in `backend/reference/apd-sql/` (served read-only by `/api/product/apd-sql?path=…`), so Product Wise does not read `third_party/` at runtime.

### Automatic Payments Dashboard on / off

Every APD board now lives in Product Wise. Switch the legacy page off in **Connector Settings → Dashboards** (or on the Automatic Payments page): it leaves the sidebar, its 10:15 IST refresh stops and Today drops its line. Saved in `backend/data/apd-config.json`; API `GET|POST /api/apd/config {"enabled": false}`. A missing or renamed `third_party/apd_installer` counts as off; tested with the folder renamed — all dashboards and queries keep working.

Product Wise API: `/api/product/state|run|stop|sql|rows`, `/api/product/asof?product=&to=&range=`, `/api/product/backfill`, `/api/product/cccasa/compare?pivot=&format=xlsx`, `/api/product/error-sheet`. Failure-code party rules: `backend/codeParty.js`.

### Acquiring SR (`#acqsr`)

SR for PPSL Intent V2, PPSL DQR, OCL DQR and Collect (plus P2M other, P2P, Lite) from the PTYBL switch DB on clusters C2 / C3 / C6, read through Redash. Files: `backend/acqCollector.js` (collector, job queue, storage), `backend/acquiringSr.js` (routes, routing checks), `src/sr-acquiring.jsx`.

**Views**

| View | What it shows |
|---|---|
| Recent (1–24h · any date) | SR per 10 / 30 / 60 min with SR-impact flags, incidents and decline codes. **Live** follows the newest data; **Pick date** shows any stored day up to a chosen hour (`/api/acq/recent?date=2026-11-08&until=18:00&hours=6`). Decline codes are per 10-min slot for the last 24h, per hour (all clusters) for older windows |
| Daily SR pattern | SR by time of day per flow, each day a line, min–max / median band of earlier days, night vs day gap (3–60 days) |
| Daily (up to 60 days) | Day totals per flow and cluster, decline mix, stuck PENDING / DEEMED, hourly SR |
| History | SR-impact strip per day and the merged incidents (3–60 days), job run history |

Opening a view never queries Redash; everything comes from stored slots.

**Collection and slave protection**

- `recent:C2|C3|C6` read each 10-min slot 5 min after it ends and once more at 20 min (settle). A slot not read within 45 min is left for the night.
- `night` (01:00–06:00 IST, `ACQ_NIGHT_WINDOW`) fills missing slots newest first, C2 / C3 / C6 in lockstep (one query per host at a time), under a DB-minute budget. Plan a deeper fill for one night: `curl -s -XPOST localhost:5000/api/acq/night/plan -H 'content-type: application/json' -d '{"fillTo":"2026-11-06 00:00","budgetMin":600}'`.
- `trickle` (daytime, optional) reads one old cluster-slot per chunk in 1-min pieces (≤15 s each), only while the queue is idle, up to a daily DB budget: `POST /api/acq/trickle {"fillTo","budgetMin","everyMin"}` or `{"off":true}`.
- Every query carries a MySQL time limit (20 s day, 60 s night). A slow or stopped query rests the queue 10 min; a stopped trickle piece pauses only the trickle for 30 min.
- `ppsl` (PMS full-table scan) runs only between 01:00 and 06:00 IST, even if the night window is moved earlier.

**Storage** (`backend/data/acq/`, local, gitignored)

| Path | Holds |
|---|---|
| `days/YYYY-MM-DD.json` | One IST day, about 230 KB: flow totals, hourly totals, decline codes (day and hourly), stuck counts, and the 10-min series per cluster and flow `[total, success, fail, u09, pending, deemed]`. Only changed days are rewritten |
| `state.json` | Cluster heads and gaps, night / trickle plans and budget use, and the raw rows of each slot for the last 24h (`ACQ_PROVISIONAL_HOURS`), used for re-reads and per-slot decline codes |
| `archive/YYYY-MM-DD.json.gz` | Days older than 30 days (`ACQ_HOT_DAYS`), about 54 KB each, checked byte for byte before the plain file is removed and read back when a view needs that date |

- Retention: archived days older than 60 days are removed (`ACQ_RETENTION_DAYS`, `0` = keep forever). `ACQ_ARCHIVE_DIR` puts the archive elsewhere, for example a synced Google Drive folder.
- Files are written to `.tmp` and renamed, so a crash never leaves a half-written file. An unreadable day file is set aside (`.bad-…`), never overwritten.
- Run log: `backend/data/acq-runs.jsonl` (one line per job run, older half cut past 2 MB).
- Migration (11 Nov 2026): the old single file was split into this layout, every day verified identical, and kept as `backend/data/acq-daily.migrated-2026-11-11.json`; a copy of the pre-change files is in `backend/data/acq-backup-20261111-1444/`.

API: `/api/acq/status|recent|history|pattern|daily|runs`, `POST /api/acq/jobs/run|stop|retry`, `/api/acq/night/plan`, `/api/acq/trickle`, `/api/acq/collector/pause|resume`.

---

## LLM routing

All agents except Analyst use `POST /api/generate` with auto-fallback chain:

```
AWS Bedrock (HTTP gateway) → Foundry/internal LLM → OpenAI
```

Provider selected from **Connectors** tab in UI (stored in localStorage). Analyst Agent calls OpenAI directly (`gpt-4.1-mini`).

Alpha Agent (`/api/alpha/chat`) uses same chain but also injects live UPI Alpha context:
- `SOUL.md`, `CLAUDE.md`, `PRODUCTS.md`, `INDEX.md` from UPI Alpha Google Drive folder
- BM25 keyword search over `wiki/` (282 feature pages, 66 competitor app profiles)

---

## Quick start

```bash
# 1. Install
npm install
cd backend && npm install && cd ..
cd Query_Agent && npm install && cd ..

# 2. Copy env
cp .env.example .env   # fill in your secrets

# 3. Start everything
npm run dev            # backend :5000 + frontend :3000
npm run dev:analyst    # Analyst Agent :3040 (separate terminal)

# OR use /letsbegin in Claude Code — starts all + opens browsers + tails logs
```

---

## Environment variables

Copy `.env.example` → `.env`. Key groups:

**LLM (primary — Foundry/internal gateway)**
```
LLM_API_KEY=...
LLM_URL=https://...
LLM_MODEL=pi-agentic/global-anthropic-claude-opus-...
```

**LLM (AWS Bedrock — preferred, used first)**
```
BEDROCK_INVOKE_URL=https://....lambda-url.ap-south-1.on.aws/
BEDROCK_USE_DEFAULT_CREDENTIALS=true
BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-6
AWS_REGION=ap-south-1
```

**Jira**
```
JIRA_URL=https://yourcompany.atlassian.net
JIRA_URL_2=https://secondary-site.atlassian.net       # secondary site
JIRA_SECONDARY_PROJECT_KEYS=TPAP,PCO,TPG        # routed to JIRA_URL_2
JIRA_EMAIL=you@company.com
JIRA_TOKEN=...
```

**Scoring**
```
OPENAI_API_KEY=sk-...
SCORE_MODEL=gpt-4.1-mini
# or Foundry:
SCORE_LLM_URL=...
SCORE_LLM_MODEL=...
```

**Notifications**
```
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
TELEGRAM_BOT_TOKEN=...
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_USER=...
EMAIL_PASS=...
```

**Analyst Agent**
```
TRINO_API_URL=https://trino.example.com/
TRINO_SERVICE_USER=service@company.com
TRINO_SERVICE_PASSWORD=...
TRINO_CATALOG=hive
TRINO_MAX_ROWS=1000
QUERY_AGENT_SCHEMA_FILE=/path/to/SCHEMA.md    # absolute path OK
QUERY_AGENT_REFERENCE_QUERIES_ROOT=Resources/Reference_Queries
QUERY_AGENT_KNOWLEDGE_ROOT=Resources/Knowledge Resources
OPENAI_API_KEY=sk-...
NEXTAUTH_URL=http://localhost:3040
NEXTAUTH_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

---

## UPI Alpha integration

UPI Alpha (Google Drive folder) is linked via symlinks — **no files copied**:

```
Query_Agent/Resources/Reference_Queries/UPI-Alpha-Queries → GDrive/UPI Alpha/Queries/
Query_Agent/Resources/Knowledge Resources/UPI-Alpha-Wiki  → GDrive/UPI Alpha/wiki/
```

Schema env var points directly to GDrive `SCHEMA.md`. Alpha Agent backend route reads all context live from GDrive on every request.

---

## MCP servers

Four external MCP servers registered in Claude Desktop:

| Name | Port/type | Purpose |
|---|---|---|
| `kb-mcp-server` | stdio | Knowledge base search |
| `redash-mcp` | stdio | Redash query access |
| `mcp-server-prometheus` | stdio | Prometheus metrics |
| `superset-mcp` | stdio | Apache Superset |

Start all at once:
```bash
bash scripts/start-mcps.sh
# or via Claude Code:
/letsbegin      # starts agents + MCPs + opens browsers + tails logs
```

Logs: `.claude/mcp-kb.log`, `.claude/mcp-redash.log`, `.claude/mcp-prometheus.log`, `.claude/mcp-superset.log`

---

## Terminal logs

Double-click `scripts/live-agent-logs.command` (macOS) to open Terminal tailing all 7 log files simultaneously. LLM calls log with ISO timestamps:

```
[2026-05-15T04:12:34.123Z] [api/generate] provider=aws tier(default)
[2026-05-15T04:12:37.891Z] [api/generate] ✓ provider=aws model=sonnet ms=3768
[2026-05-15T04:12:37.892Z] [alpha] ✓ provider=aws ms=4102 filesUsed=4
```

---

## Security

- `.env` and `backend/.env` are gitignored. Never commit secrets.
- Before pushing: `git status` — verify no `.env`, `.log`, or temp config files staged.
- If GitGuardian flags a secret: rotate it in the external service first, then scrub git history.

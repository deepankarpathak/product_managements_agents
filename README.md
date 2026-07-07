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
│   └── analyst-agent.jsx   Analyst iframe wrapper
├── backend/
│   └── server.js           Express 5 ESM backend (port 5000)
│       ├── /api/generate   Main LLM route (PRD/UAT/BRD/JIRA)
│       ├── /api/claude     Direct Anthropic/Foundry route (BRD)
│       ├── /api/alpha/chat Alpha Agent chat (UPI wiki + LLM)
│       ├── /api/jira/*     Jira CRUD
│       ├── /api/share/*    Publish (Jira/Email/Slack/Telegram)
│       └── /api/score      Document quality scoring
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
JIRA_URL_2=https://mypaytm.atlassian.net        # secondary site
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
TRINO_API_URL=https://cdp-trino-query.platform.mypaytm.com/
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

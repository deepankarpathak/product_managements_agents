---
description: Start all agents, open browsers, open live API log terminal (macOS)
argument-hint: optional note
---

When the user runs `/letsbegin`, call the **prd-agent-launcher** MCP tool **`letsbegin`** (approve if prompted).

## After the tool returns — verify every required service

`letsbegin` only checks that ports accept TCP; a port can be open while the service behind it is dead or mid-restart (the backend runs under `node --watch`, so every backend file edit restarts it). Verify each service by HTTP and report a table of ✅ / ❌ per row. Wait ~10s after a fresh start before checking.

| # | Service | Port | Health check (from `~/prd-agent`) | Needed by |
|---|---------|------|-----------------------------------|-----------|
| 1 | Node API backend (Express) | 5000 | `curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:5000/api/connectors/status` → 200 | Every tab; all `/api/*` calls |
| 2 | Unified SR dashboard API | 5000 | `curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:5000/api/udash/state` → 200 | Unified SR dashboard |
| 3 | SR Snippet / Product / History / Today APIs | 5000 | `/api/srsnippet/state`, `/api/product/state?product=international`, `/api/history/list`, `/api/home/summary`, `/api/spec/search?q=U16` → 200 | SR Snippet, Product Wise, History, Today, Utilities tabs |
| 3a | Jarvis proxy (remote `https://ai-tools.finmate.tech`) | 5000 | `/api/jarvis/srdissect/runs`, `/api/jarvis/sragent/last`, `/api/jarvis/hss`, `/api/jarvis/lumina/summary` → 200 (`/api/jarvis/sragent/benchmark` is POST-only; `/api/jarvis/txn/auth` returns 401 without the `X-RCA-Auth` password, which is expected) | SR Dissection, SR vs Peers, HSS Traffic, Lumina, Txn Tracer, Today |
| 3b | LLM providers | 5000 | `curl -s localhost:5000/api/connectors/status` → `llmProviders[]`: report `ok` per provider (bedrock, foundry, openai, gemini, anthropic) with its error text. Then a real call: `curl -s -m 90 localhost:5000/api/generate -H 'Content-Type: application/json' -d '{"agent":"healthcheck","skipRag":true,"llmProvider":"auto","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":10}'` → `success:true` | PRD, BRD, UAT, JIRA agents, scoring, Alpha, Analyst (OpenAI) |
| 4 | React frontend (CRA dev server) | 3000 | `curl -s -m 10 -o /dev/null -w "%{http_code}" http://localhost:3000` → 200 | Main UI |
| 5 | Frontend → backend proxy | 3000→5000 | `curl -s -m 15 -o /dev/null -w "%{http_code}" http://localhost:3000/api/udash/state` → 200 (**504 here = proxy cannot reach :5000**) | Unified SR dashboard and all tabs |
| 6 | Analyst Agent (Next.js) | 3040 | `curl -s -m 10 -o /dev/null -w "%{http_code}" http://localhost:3040` → 200/307 | Analyst tab |
| 7 | Alpha Agent (Next.js) | 3050 | `curl -s -m 10 -o /dev/null -w "%{http_code}" http://localhost:3050` → 200/307 | α Alpha Agent tab |
| 8 | Trino (remote, needs VPN) | — | `TRINO_API_URL` set in `.env`; `curl -s -m 10 -o /dev/null -w "%{http_code}" "$TRINO_API_URL"` returns any HTTP code (000 = VPN/network down) | Unified SR dashboard long windows, SR Snippet, Product Wise, Analyst |
| 9 | Redash switch DB (remote, needs VPN) | — | Redash URL set in Unified SR dashboard settings; host reachable | Unified SR dashboard windows ≤ 4h |
| 10 | MCP servers | — | `prd-agent-tools` and `jira-mcp` connected (from tool result `mcpServers`) | Claude-side tools |

Never print `.env` secret values; only say whether a variable is set.

## Auto-fix rules

- **Row 1/2 fail (backend down, 000/502/504):** check `tail -60 .claude/main-dev.log` for a crash (syntax error, `EADDRINUSE`, missing module). If it crashed on a code error, report the error and file:line — do not loop restarts. If it is simply not running, start it with `npm run start:backend` in the background (log to `.claude/main-dev.log`), wait ~10s, re-check.
- **Row 5 fails but rows 1–2 pass:** the CRA proxy is stale or targets the wrong host. Check `REACT_APP_PROXY_TARGET` (default `http://127.0.0.1:5000`, see `src/setupProxy.js`). Tell the user to hard-refresh; if it still fails, restart the frontend.
- **Duplicate stacks:** run `ps -ef | grep -E "npm run dev|concurrently|start:backend" | grep -v grep`. If more than one `npm run dev` exists, report it — a second stack's frontend exits because :3000 is taken while its backend may own :5000, so killing the "wrong" one takes the API down. Ask before killing anything.
- **Row 3b fails:** these are credential problems (key expired, 403/401, out of credits, retired model), not code. Report each provider's error and the `.env` variable to fix (`BEDROCK_API_KEY`, Foundry service account / `LLM_KEY_API`, `OPENAI_API_KEY` billing, `ANTHROPIC_API_KEY`, `GEMINI_MODEL`). `LLM_PROVIDER_DEFAULT` (default `aws`) picks the route when the UI sends none. Dashboards still work; only generation/scoring/chat break.
- **Row 3a fails with 5xx/timeout:** Jarvis is remote; check `curl -s -o /dev/null -w "%{http_code}" https://ai-tools.finmate.tech` (needs VPN).
- **Row 8/9 fail:** tell the user to connect VPN; the dashboard UI loads but query sections will error/timeout.
- If ports were already up, the tool may say it **skipped** starting servers — that is normal, but still run the health checks above.

## Confirm in your reply

1. **Main app** — http://localhost:3000 (Today, Unified SR, SR Dissection, SR vs Peers, SR Snippet, Product Wise, HSS Traffic, History, PRD, BRD, UAT, JIRA, Lumina, Analyst, Alpha, Txn Tracer, Utilities); API http://localhost:5000
2. **Analyst** — http://localhost:3040 (also embedded in the Analyst tab)
3. **Alpha Agent** — http://localhost:3050 (also embedded as α Alpha Agent tab)
4. **Health table** — the 10-row ✅ / ❌ table above
5. **Terminal** — On macOS, Terminal should open tailing `.claude/main-dev.log`, `.claude/analyst-dev.log`, and `.claude/alpha-dev.log` with `[api]` (Express) and `[analyst-api]` (Next) lines
6. If **`letsbegin`** reports Analyst missing **`Query_Agent`**, stop and tell the user to restore that folder
7. If **`letsbegin`** reports Alpha missing **`alpha-web-ui`**, stop and tell the user to sync it from Google Drive

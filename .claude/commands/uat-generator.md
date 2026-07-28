---
description: Generate UAT signoff for a JIRA ticket (TSP/TPAP). Fetches ticket, extracts attachments, reads local Drive test cases, runs discrepancy analysis, produces signoff.
argument-hint: JIRA ID or URL, e.g. TSP-5804 or https://finmate.atlassian.net/browse/TSP-5804
---

When user runs `/uat-generator [JIRA-ID]`:

1. **Confirm services are up** — backend http://localhost:5000, frontend http://localhost:3000. If down, call `letsbegin` MCP tool first.

2. **Instruct user** — open http://localhost:3000 in browser, click the **UAT** tab.

3. **Walk user through the 5-step flow:**
   - **Step 0 — Input**: Paste the JIRA ID (e.g. `TSP-5804`) in the JIRA field → click **Fetch + Discover**
   - **Step 1 — Discovery**: System auto-fetches ticket, extracts attachments (PDF/DOCX), reads `{JIRA-ID}.csv` from `~/My Drive/` for QA test cases. Wait for "✅ Discovery complete".
   - **Step 2 — Clarify**: Review gap questions. Answer unknowns or leave blank. Click **Continue**.
   - **Step 3 — Review**: Confirm context summary → click **Generate UAT Signoff**.
   - **Step 4 — Result**: UAT signoff with Defect/Gap Summary, Score, Final Decision. Optionally run Discrepancy Analysis.

4. **Local Drive test cases setup** — if discovery warns `localNotFound`:
   - Open the Google Sheet linked in the JIRA ticket
   - Go to the tab named exactly `{JIRA-ID}` (e.g. `TSP-5804`)
   - File → Download → CSV → rename to `{JIRA-ID}.csv`
   - Save to `~/My Drive/{JIRA-ID}.csv`
   - Re-run discovery

5. **After UAT completes** — a yellow banner appears asking to delete the local CSV. User must explicitly confirm before deletion.

6. **MCP shortcut (Claude CLI only)** — if user wants to generate UAT without opening browser:
   - Call `mcp__prd-agent-tools__generate_uat` with the JIRA context
   - Call `mcp__prd-agent-tools__jira_get_issue` first to fetch ticket fields

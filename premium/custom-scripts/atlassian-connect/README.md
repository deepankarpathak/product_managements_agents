# Atlassian (JIRA / Confluence) — Connection Methodology

**Purpose:** Pattern for connecting scripts to JIRA (and Confluence) for ticket creation, lookup, and update. Two supported methods: REST API (always works) and MCP (nicer UX when network allows).

---

## Two methods, pick one per situation

| Method | When to use | Pros | Cons |
|---|---|---|---|
| **REST API + API token** | Always works. Scripting. Corporate network. | Reliable, scriptable, no network gotchas. | You write the HTTP calls. |
| **MCP server** | Interactive conversations in Claude Code. | Natural language ("read JIRA ticket X"). No scripting needed. | Requires `mcp.atlassian.com` to be reachable — corporate firewalls sometimes block it. |

**Rule of thumb:** use REST API for automation / reliable scripted work. Use MCP for ad-hoc lookups during Claude conversations when both are available.

---

## Method 1: REST API + API token

### One-time setup
1. Generate an API token at your Atlassian account's security page (look for "API tokens" under profile settings).
2. Store the token in a gitignored `.env` file in your project root:
   ```
   ATLASSIAN_EMAIL=your.name@company.com
   ATLASSIAN_API_TOKEN=your-token-here
   ATLASSIAN_DOMAIN=your-workspace.atlassian.net
   ```
3. Add `.env` to `.gitignore` BEFORE your first commit.

### Python script pattern
```python
import os
import requests
from requests.auth import HTTPBasicAuth
from dotenv import load_dotenv

load_dotenv()

EMAIL = os.environ["ATLASSIAN_EMAIL"]
TOKEN = os.environ["ATLASSIAN_API_TOKEN"]
DOMAIN = os.environ["ATLASSIAN_DOMAIN"]
AUTH = HTTPBasicAuth(EMAIL, TOKEN)
BASE = f"https://{DOMAIN}/rest/api/3"

def get_ticket(key):
    r = requests.get(f"{BASE}/issue/{key}", auth=AUTH)
    r.raise_for_status()
    return r.json()

def create_ticket(project_key, summary, description, issue_type="Task"):
    payload = {
        "fields": {
            "project": {"key": project_key},
            "summary": summary,
            "description": {"type": "doc", "version": 1, "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": description}]}
            ]},
            "issuetype": {"name": issue_type},
        }
    }
    r = requests.post(f"{BASE}/issue", auth=AUTH, json=payload)
    r.raise_for_status()
    return r.json()
```

### Common endpoints
- `GET /rest/api/3/issue/{key}` — read ticket
- `POST /rest/api/3/issue` — create ticket
- `PUT /rest/api/3/issue/{key}` — update ticket
- `POST /rest/api/3/issue/{key}/comment` — add comment
- `GET /wiki/rest/api/content/{pageId}` — read Confluence page

---

## Method 2: MCP server (via Claude Code)

### Setup
1. In Claude Code terminal, type `/mcp`
2. Look for "Atlassian" in the server list
3. If present, select it. First use triggers browser authentication — log in with your Atlassian account.
4. Done. Natural language queries work: "read JIRA ticket PROJ-1234" or "list tickets in project FOO assigned to me".

### Limitations
- MCP goes through `mcp.atlassian.com`. Some corporate networks block this. If so, fall back to REST API.
- Not scriptable outside Claude Code.

---

## JIRA content conventions (worth enforcing)

When creating tickets from analysis, these fields are worth populating consistently:

| Field | Why |
|---|---|
| **Title** | Specific and actionable. Not "Fix search" — "Fix provider alias matching in checkout search." |
| **Problem** | Quantified. "<Segment> failure rate is X% vs Y% overall" not "users are failing." |
| **Evidence** | Source + date + filters. Cite the query or knowledge file. |
| **Impact** | INR/month OR users affected OR % of funnel. Flag "unquantified" if you genuinely don't know. |
| **Proposed Fix** | Specific. "Add alias mapping for X → Y" not "improve matching." |
| **Acceptance Criteria** | Measurable outcomes. |

The `/ship` skill in this framework enforces this structure.

---

## Security notes

- **Never commit API tokens.** `.env` in `.gitignore` before first commit.
- Rotate tokens every 6-12 months. Atlassian account security page supports revocation.
- Use project-scoped tokens where possible (some Atlassian tiers support this).
- If a token is ever pasted into a chat, log, or issue — revoke it immediately and generate a new one.
- Review `git log -p | grep -i token` periodically to catch accidental commits.

---

## Getting access (for new PMs)

- You need an Atlassian account with access to the target project / space.
- For API token generation: account must be active and 2FA may be required depending on Workspace policy.
- For creating tickets: your account needs "Create Issues" permission in the target project.
- For Confluence: "View" permission on the space; "Edit" if writing.

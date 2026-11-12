# MCP Servers — Setup Methodology

**Purpose:** How to activate MCP (Model Context Protocol) servers in Claude Code. Applies to Figma, Slack, Atlassian, Google Drive, and any other MCP integration your team uses.

---

## What MCP is (briefly)

MCP servers expose tools to Claude Code that let Claude read/write external services — e.g. "read this Figma file", "post to this Slack channel", "list Google Drive files". Each server is its own OAuth connection.

In this framework, MCPs are useful for:
- Reading design files during UI investigation (Figma)
- Posting updates or reading team messages (Slack)
- Quick lookups during conversation (Atlassian, Drive)

They are NOT a substitute for scripted automation. For automation, use the REST API methods documented in the other folders here.

---

## Activating an MCP server

### Step-by-step
1. In Claude Code terminal, type `/mcp` (lowercase, with the slash).
2. A list appears with all configured MCP servers for your Claude Code install.
3. If the server you want is listed as "not authenticated", select it.
4. Claude shows an authentication URL — copy to browser.
5. Log in to the service, click "Allow" on the consent screen.
6. Browser redirects to a `localhost:<port>/callback` URL. This may show a "page not found" error — that's OK. Copy the full URL from the address bar.
7. Paste the URL back into Claude Code when prompted.
8. Server is now authenticated. Its tools are available in the current conversation.

### Confirming it worked
After authentication, Claude can invoke the server's tools. Test by asking a natural-language question appropriate to the server:
- Figma: "summarize this design: <figma URL>"
- Slack: "search the #product channel for messages about X"
- Drive: "list files in folder <name>"

If Claude says "I don't have access to that" or "MCP not available", authentication didn't stick. Re-run `/mcp`.

---

## Common gotchas

### Network blocks
MCP servers communicate through endpoints like `mcp.figma.com`, `mcp.atlassian.com`, `drivemcp.googleapis.com`. Corporate firewalls sometimes block these. Test with:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.atlassian.com
```
- `200` / `301` / `302` = reachable
- `000` or timeout = blocked; try VPN or fall back to REST API method

### Token expiration
MCP tokens expire periodically (typically every few days to weeks, depends on service). When they do, you'll see authentication errors. Re-run `/mcp` and re-authenticate.

### Multiple accounts
If you have multiple Google / Figma / Atlassian accounts, authentication picks whichever was logged into the browser first. If you get unexpected data, log out of the service in your browser and re-authenticate through `/mcp`.

### MCP not listed
If `/mcp` doesn't show the server you need, it's not configured for your Claude Code install. Options:
- Ask your team lead for the MCP config
- Check official MCP server directory for the service
- Use the REST API alternative if one exists

---

## What each MCP typically gives you

Your mileage depends on which MCPs your Claude Code install has. Common ones:

| Server | Useful for |
|---|---|
| **Figma** | Read design files, get screenshots, understand upcoming UI changes |
| **Slack** | Read channel messages, search conversations, post updates |
| **Atlassian** | Read/update JIRA tickets, read Confluence pages (natural language only; for scripted use see `atlassian-connect/`) |
| **Google Drive** | List files, read Docs, limited write (for create-sheet, see `google-workspace-connect/`) |
| **Gmail** | Read/draft email, manage labels |
| **Calendar** | Read/create events |

---

## When NOT to use MCP

- **Bulk / scripted operations** — MCP is interactive. For automation, use the service's REST API.
- **Corporate-network-blocked services** — MCP endpoints often route through vendor domains that corporate firewalls block. REST API goes direct to the service's own domain and may work when MCP doesn't.
- **Write operations needing audit trail** — MCP writes happen inside Claude conversations. If you need a logged, re-runnable script, use REST API.

---

## Security notes

- MCP tokens are stored by Claude Code locally (typically in `~/.config/claude/` or similar). Treat them like passwords.
- Grant the minimum scopes each MCP asks for. Don't authorize broader scopes "just in case."
- When leaving a team or rotating machines, sign out of MCPs via `/mcp` → select → "logout", or revoke in the service's connected-apps page.
- Don't share MCP-authenticated Claude Code installs across users.

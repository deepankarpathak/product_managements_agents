# Google Workspace — Connection Methodology

**Purpose:** Reusable pattern for connecting Python scripts to Google Sheets / Drive / Gmail from a corporate machine.

**Why this exists:** Onboarding to Google APIs from a corporate network hits two consistent gotchas. This doc captures both so you don't rediscover them.

---

## Choose your auth method

| Method | When to use | Limitation |
|---|---|---|
| **Service account** | You only need to READ sheets/docs that have been shared with the service account's email. Best for automated scripts that run unattended. | Cannot CREATE sheets — service accounts have no Drive storage quota by default. |
| **OAuth user** | You need to CREATE / WRITE sheets or Drive files. Best when the artifact should be owned by you. | First run requires browser consent. Token caches locally after that. |

**Rule of thumb:** reading existing sheets = service account; creating new sheets = OAuth user.

---

## Gotcha #1 — Service accounts can't create sheets

Service accounts have no Drive storage. `drive.files.create` returns **403: "The user's Drive storage quota has been exceeded."**

**Fix:** use OAuth user credentials instead. OAuth authorizes AS you, so the sheet is created under your own Drive (where you have quota).

Alternative for unattended scripts that must use SA: create sheets in a **shared Drive** that the service account has been granted access to. Requires Workspace admin to set up.

---

## Gotcha #2 — Corporate network may block `oauth2.googleapis.com`

Symptom on macOS:
```
ConnectionError: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443):
Failed to establish a new connection: [Errno 49] Can't assign requested address
```

The "Errno 49" + "Immediate connect fail" (<5ms) is the signature. It's NOT a timeout or firewall deny — the OS refuses to even open the socket.

### Diagnosis
```
route get oauth2.googleapis.com
```
If the reported `gateway` IP is NOT in the subnet of the reported `interface` IP, you have a broken static route. macOS can't send packets to an unreachable gateway, hence Errno 49.

### Root cause
A corporate VPN or network profile has pushed a static route for the specific Google API IP (e.g. 192.178.211.95) pointing to a gateway that isn't reachable from your current network subnet.

### Fixes, in order of preference

**1. Delete the broken route (permanent, requires sudo):**
```
sudo route delete -host <IP_OF_oauth2_googleapis_com>
```
Then the default route handles it. Works permanently until VPN re-pushes the route.

**2. Full VPN disconnect + reconnect:**
Sometimes fixes stale route tables.

**3. Runtime DNS override (no sudo, per-script):**
Force the Python HTTPS connection to use a different Google frontend IP. Google routes by SNI, so any Google frontend IP will serve any `*.googleapis.com` domain. See `connect-template.py` for the 8-line patch.

The DNS override is the most portable fix — works even on locked-down machines without sudo. TLS certificate validation remains intact (SNI-based), so it's secure.

---

## Template structure

`connect-template.py` demonstrates:
- DNS override patch (can be removed if your network has no route issue)
- OAuth user flow with token caching
- Create + write to a Sheet

Copy and adapt the template to your use case. Inputs to replace:
- Path to your OAuth client JSON (`oauth_credentials.json` from your Google Cloud project)
- Desired local path to cache the token
- Scopes appropriate for your task
- The data you want written

---

## Setup checklist (one-time, per workspace)

1. Create a Google Cloud project (console.cloud.google.com)
2. Enable the APIs you need (Sheets API, Drive API, Gmail API)
3. Create an OAuth 2.0 Client ID (type: Desktop app)
4. Download the client JSON → save as `oauth_credentials.json` somewhere your scripts can read (NOT committed to Git)
5. Install Python libs: `pip3 install --user gspread google-auth google-auth-oauthlib`
6. Run the template script once; complete browser consent; token gets cached for future runs

---

## Security notes

- **Never commit** `oauth_credentials.json` or cached token files. Add both to `.gitignore`.
- Token files contain refresh tokens. Treat them like passwords. Store in a user-scoped path (e.g. `~/.config/<project>/`) with `chmod 600` if you want strict hygiene.
- OAuth scopes requested should be minimum required. `spreadsheets` + `drive` is the common pair for sheet create/read/write. Don't add broader scopes than needed.
- The DNS override in the template does NOT weaken TLS. Python still validates the server certificate via SNI. The only change is which IP the TCP socket dials.

---

## Fallback only: gws CLI

**Use this ONLY if the Python path above doesn't work for you.** Otherwise stick with Python — the template is already working end-to-end and handles the common gotchas.

When the fallback is worth trying:
- You need to run quick one-off Google Workspace commands from the terminal without writing a script
- The Python setup is blocked (e.g. pip can't install on your machine)

Steps:
1. **Correct package name:** `@googleworkspace/cli` (NOT `@anthropic-ai/gws` — that scope returns 404 on public npm).
   ```
   npm install -g @googleworkspace/cli
   ```
   If npm's post-install download fails, grab the binary tarball directly from GitHub Releases: `https://github.com/googleworkspace/cli/releases/` → pick the one matching your OS/arch.
2. **Authenticate:** `gws auth login` (opens browser for OAuth consent).
3. **Test:** `gws sheets spreadsheets create --json '{"properties": {"title": "Test"}}'`

Important: gws hits the **same** `oauth2.googleapis.com` endpoint the Python path does. If you saw the `errno 49 / can't assign requested address` error with Python, gws will fail the same way. Apply the same network fix first (`sudo route delete -host <IP>` or VPN reconnect). The Python template's runtime DNS-override trick doesn't apply to gws — for gws you must fix the network layer or use an OS-level `/etc/hosts` override.

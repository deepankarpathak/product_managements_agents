# Bitbucket — Connection Methodology

**Purpose:** Authenticate to Bitbucket Cloud for git operations (clone, push, pull) and for the Bitbucket REST API (creating PRs from scripts, reading PR state).

**Why this is its own doc:** Bitbucket is owned by Atlassian, but it does **not** share authentication with JIRA / Confluence. An Atlassian API token (which works for JIRA / Confluence — see `atlassian-connect/README.md`) will be rejected by Bitbucket. Bitbucket has its own credential system. This trips up most people once.

---

## Three methods, pick one per situation

| Method | When to use | Pros | Cons |
|---|---|---|---|
| **SSH key** | Daily git operations from your laptop | Set up once, works forever, no password prompts | One-time SSH setup |
| **App Password** | HTTPS git operations or REST API scripting | Scriptable, easy to rotate | Treat like a password — can't be seen again after creation |
| **OAuth (via 3rd-party tools)** | IDE plugins, GUI git clients | Best UX inside specific tools | Tool-specific, not portable |

**Rule of thumb:** use **SSH** for your daily `git push / pull / clone`. Use **App Password** only when you need scripted REST API calls or HTTPS-only environments.

---

## Method 1: SSH key (recommended for daily use)

### One-time setup

1. Generate an SSH key on your machine if you don't already have one:
   ```bash
   ls ~/.ssh/id_ed25519.pub        # check if you already have one
   ssh-keygen -t ed25519 -C "your.name@company.com"   # if not, create
   ```
   Press Enter to accept defaults. Set a passphrase (recommended) or leave blank.

2. Copy the public key:
   ```bash
   pbcopy < ~/.ssh/id_ed25519.pub          # macOS
   # or: cat ~/.ssh/id_ed25519.pub         # any OS, then copy manually
   ```

3. Add it in Bitbucket:
   - `bitbucket.org` → click your avatar (top-right) → **Personal settings** → **SSH keys** → **Add key**
   - Label: e.g. `MacBook 2026-05`. Paste the public key. Save.

4. Test:
   ```bash
   ssh -T git@bitbucket.org
   ```
   Expected: `authenticated via ssh key. You can use git to connect to Bitbucket.`

### Using SSH for git operations

Always clone with the **SSH URL**, not HTTPS:

```bash
git clone git@bitbucket.org:<workspace>/<repo>.git     # SSH ✅
git clone https://bitbucket.org/<workspace>/<repo>.git # HTTPS — needs App Password ❌
```

If you already cloned via HTTPS and want to switch:
```bash
git remote set-url origin git@bitbucket.org:<workspace>/<repo>.git
git remote -v   # verify
```

---

## Method 2: App Password (for HTTPS or REST API)

Bitbucket App Passwords are **per-user, scoped credentials** — distinct from your account password and from any Atlassian API token.

### One-time setup

1. `bitbucket.org` → avatar → **Personal settings** → **App passwords** → **Create app password**.
2. Label: descriptive (e.g. `local-cli-2026-05`).
3. Permissions: pick the minimum scopes you need. For typical PM use:
   - `Repositories: Read, Write` — for git over HTTPS
   - `Pull requests: Read, Write` — for creating PRs via API
   - `Account: Read` — required by some endpoints
4. **Save the password immediately.** Bitbucket shows it once, then never again. Lose it = revoke and create a new one.
5. Store it in a gitignored `.env`:
   ```
   BITBUCKET_USERNAME=your-bb-username
   BITBUCKET_APP_PASSWORD=<the-generated-password>
   ```

### Using it for HTTPS git operations

When git prompts for a password during HTTPS push/pull, paste the App Password (not your Atlassian password).

To skip the prompt every time, configure git's credential helper:

```bash
# macOS — store in keychain
git config --global credential.helper osxkeychain
# Linux — cache for 1 hour
git config --global credential.helper "cache --timeout=3600"
```

### Using it for the REST API

```bash
# Example: list open PRs
curl -u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD" \
  https://api.bitbucket.org/2.0/repositories/<workspace>/<repo>/pullrequests?state=OPEN

# Example: create a PR
curl -u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD" \
  -X POST \
  -H "Content-Type: application/json" \
  https://api.bitbucket.org/2.0/repositories/<workspace>/<repo>/pullrequests \
  -d '{
    "title": "<title>",
    "source": {"branch": {"name": "<branch>"}},
    "destination": {"branch": {"name": "main"}},
    "description": "<body>",
    "close_source_branch": true
  }'
```

REST API docs: https://developer.atlassian.com/cloud/bitbucket/rest/intro/

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Authentication failed for 'https://bitbucket.org/...'` | Trying HTTPS with your Atlassian password or API token | Either switch to SSH (Method 1) or generate an App Password (Method 2) |
| `Permission denied (publickey)` on SSH | Key not added to Bitbucket, or wrong key being offered | Verify with `ssh -T git@bitbucket.org`. Use `ssh-add` if you have an agent. |
| App Password lost | Bitbucket only shows it once | Revoke and create a new one. |
| `git push` rejected `(non-fast-forward)` after a colleague pushes | Your local `main` is behind | `git pull --rebase origin main` then push, OR push to a feature branch and PR |
| `git push` rejected `(protected branch)` | Branch restriction is preventing direct push | Push to a feature branch and open a PR — that's the intended flow |

---

## Security notes

- **Never commit App Passwords or SSH private keys.** `.env` and `~/.ssh/id_*` (without `.pub`) must be in `.gitignore` BEFORE first commit.
- **Rotate App Passwords every 6–12 months** or whenever a teammate leaves shared infrastructure. Bitbucket → Personal settings → App passwords → Revoke.
- **Scope minimally.** Don't grant `Admin` to a token used only for read-only API calls.
- **Per-machine SSH keys.** Generate a separate key per laptop / workstation. Easier to revoke if one device is lost.
- If a credential leaks (committed by accident, pasted in chat, screenshotted): revoke immediately, then create a new one.

---

## Getting access (for new contributors)

- You need a Bitbucket Cloud account in the target workspace.
- For `Repositories: Read` (clone, pull): default for any workspace member.
- For `Repositories: Write` (push to feature branches, open PRs): granted by repo admin.
- For direct push to protected branches like `main`: only specific admin users — see `CONTRIBUTING.md` in the relevant repo.

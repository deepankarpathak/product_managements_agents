# Contributing to PREMIUM-EXPORT

This repo is the source of truth for the PREMIUM-EXPORT framework. PMs and other teammates clone it, use it, and propose improvements via pull requests. This file explains how.

---

## Who can do what

| Action | Required role |
|---|---|
| Clone, read, run the framework | Anyone with repo access |
| Open a pull request | Anyone with repo access |
| Approve a pull request | Anyone with repo access (counts toward the 1 required) |
| Merge an approved pull request | **Admin** (currently: Apekshit Moudgil, Anuj Popli) |
| Push directly to `main` | **Admin** only |

`main` is protected: no force-push, no deletion, no direct push by non-admins.

---

## Making a change

**1. Get the latest `main`:**
```bash
git checkout main
git pull origin main
```

**2. Create a branch named for the change:**
```bash
git checkout -b add-skill-summarize-pulse
# good names: add-X, fix-Y, refactor-Z, docs-A
# avoid: my-changes, wip, test
```

**3. Make your edits, then commit:**
```bash
git add -A
git commit -m "Add /summarize-pulse skill"
```
Commit message style: imperative mood ("Add X", "Fix Y", "Refactor Z"). One change per commit when reasonable.

**4. Push the branch:**
```bash
git push -u origin add-skill-summarize-pulse
```

**5. Open a Pull Request on Bitbucket:**
- Bitbucket will show a "Create pull request" prompt for the branch
- Title: same as your commit message, or more descriptive
- Description: what changed, why, and any reviewer notes (see template below)
- Reviewers: assign at least one admin

**6. Get it approved and merged:**
- An admin reviews, leaves comments if anything needs change
- Once approved by 1 admin, it can be merged
- Approval is reset if you push more commits to the branch — this is intentional, push everything before requesting review
- After merge, the branch is automatically deleted (or you delete it from the PR page)

**7. Sync your local copy:**
```bash
git checkout main
git pull origin main
git branch -d add-skill-summarize-pulse  # delete the local branch
```

---

## PR description template

```
## What changed
<one to three lines describing the change>

## Why
<motivation — what problem this solves, who asked, what data prompted it>

## How to verify
<steps an admin should take to sanity-check the change>

## CHANGELOG entry
<what should appear in CHANGELOG.md when this is merged>
```

---

## Versioning and CHANGELOG

PREMIUM-EXPORT follows [Semantic Versioning](https://semver.org/):
- **MAJOR** — breaking change to skill or agent contracts.
- **MINOR** — new skill, new agent, new knowledge category, additive change.
- **PATCH** — bug fix, doc fix, internal cleanup.

**Every PR that changes user-visible behavior must update `CHANGELOG.md`** under the next unreleased version's section, following the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Trivial typo fixes don't need a CHANGELOG entry.

When admins cut a release:
1. Move "Unreleased" entries into a new dated version section in `CHANGELOG.md`
2. Bump `VERSION` to match
3. Tag the merge commit: `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`

---

## What goes in this repo

**Yes:**
- Framework files (`.claude/`, `CLAUDE.md`, `README.md`)
- Knowledge templates (`knowledge/INDEX.md` and friends — but kept generic)
- Connection methodology (`custom-scripts/`)
- Public reference files (no secrets)

**No:**
- Any individual PM's analysis findings, sessions, artifacts (those live in their own clone, gitignored)
- Credentials, tokens, API keys, `.env` files
- Personal information (own paths, internal Slack handles, customer data)
- Large binaries (>10 MB) — open an issue to discuss instead

If you accidentally commit a secret: rotate it immediately, then tell an admin so we can purge from history.

---

## Style and discipline

- **No emoji in code or docs unless explicitly asked.** Keep it text-only.
- **No marketing language.** "Powerful," "seamless," "comprehensive" — drop them.
- **Be specific in commits and PRs.** "Update docs" is bad; "Clarify /ship impact-line requirement" is good.
- **One change per PR when possible.** A skill addition + a bug fix + a doc tweak should be three PRs, not one. Easier to review, easier to revert.

---

## Who to ask

- **Workflow questions** (how do I do X?) — Apekshit Moudgil
- **Permissions / access issues** — any admin
- **Framework design questions** — read `CLAUDE.md` and the relevant `.claude/commands/<skill>.md` spec

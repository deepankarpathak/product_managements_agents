#!/usr/bin/env bash
# Auth wrapper for /logwork's Jira REST calls. Loads creds from prd-agent/.env
# (never prints them) and execs curl with -u injected, so every call this skill
# makes has one stable, permission-allowlistable command shape.
set -euo pipefail

for f in ~/prd-agent/backend/.env ~/prd-agent/.env; do
  [ -f "$f" ] && export $(grep -E '^(JIRA_EMAIL|JIRA_TOKEN|JIRA_API_TOKEN)=' "$f" | xargs -0 2>/dev/null || true)
done

TOKEN="${JIRA_TOKEN:-${JIRA_API_TOKEN:-}}"

if [ -z "${JIRA_EMAIL:-}" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: JIRA_EMAIL or JIRA_TOKEN/JIRA_API_TOKEN missing in prd-agent/.env" >&2
  exit 1
fi

exec curl -s -u "$JIRA_EMAIL:$TOKEN" "$@"

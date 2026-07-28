---
name: logwork-summary
description: >
  Send an end-of-day Jira worklog digest — Jira ID, Subject, duration logged,
  and current status for every ticket the user logged time against today (T)
  and yesterday (T-1), plus a total-minutes-per-day rollup — over Slack and
  Email (recipient from `LOGWORK_SUMMARY_TO` in prd-agent/.env). Consolidates
  worklogs from BOTH configured Jira sites — primary finmate.atlassian.net
  (anchor epic TSP-7853) and secondary mypaytm.atlassian.net (anchor epic
  TPAP-8885) — into one merged total per day; if either site is unreachable
  this run, it's excluded from the total and called out explicitly rather than
  silently under-reporting. Trigger on
  `/logwork-summary`, "end of day summary", "EOD summary", "send worklog
  summary", "how much did I log today", or when a daily ~22:00 IST scheduled
  job fires this skill. Companion to /logwork, which creates the sub-tasks and
  worklogs this skill reports on. Self-contained: talks to the Jira REST API
  via curl with credentials from prd-agent/.env, posts to Slack via
  SLACK_WEBHOOK_URL, and sends email via a direct curl SMTP upload using
  EMAIL_SMTP_HOST/PORT + EMAIL_USER/EMAIL_PASS + LOGWORK_SUMMARY_TO —
  does not touch prd-agent/backend/server.js or any other skill.
---

# /logwork-summary — End-of-Day Worklog Digest

Pulls every Jira worklog the user logged today and yesterday, and pushes a
summary to Slack and Email.

**Jira API note:** the legacy `/rest/api/3/search` endpoint is retired (HTTP
410). Always use `/rest/api/3/search/jql`.

---

## Input

None required. Always covers exactly two days: `TODAY` (T) and `YESTERDAY`
(T-1), both resolved in IST against the current date.

---

## Step 1 — Load credentials (read-only)

Same loading pattern as `/logwork`, plus Slack + Email vars:

```bash
for f in ~/prd-agent/backend/.env ~/prd-agent/.env; do
  [ -f "$f" ] && export $(grep -E '^(JIRA_URL|JIRA_URL_2|JIRA_URL_SECONDARY|JIRA_EMAIL|JIRA_TOKEN|JIRA_API_TOKEN|SLACK_WEBHOOK_URL|EMAIL_SMTP_HOST|EMAIL_SMTP_PORT|EMAIL_USER|EMAIL_PASS|EMAIL_PASSWORD|EMAIL_FROM|LOGWORK_SUMMARY_TO)=' "$f" | xargs -0 2>/dev/null || true)
done
```

If `JIRA_EMAIL`/token missing → stop, tell user to set them in `prd-agent/.env`.
If both `SLACK_WEBHOOK_URL` and (`EMAIL_SMTP_HOST` + `EMAIL_USER`) are missing →
stop, nothing to send to.
If `EMAIL_SMTP_HOST`/`EMAIL_USER` are set but `LOGWORK_SUMMARY_TO` is not, skip
the Email step (note it in the final report) rather than guessing a recipient —
this skill never hardcodes a personal email address.
If only one of Slack/Email is configured, send to that one and note in the
final report that the other channel was skipped (don't fail the whole run).

Never print `JIRA_TOKEN`, `EMAIL_PASS`, or the Slack webhook URL in any output.

---

## Step 2 — Resolve dates and account id

- `TODAY` = current date (`YYYY-MM-DD`, IST).
- `YESTERDAY` = `TODAY` minus 1 day.
- Jira base: same routing as `/logwork` Step 5 — for this digest, query BOTH
  `JIRA_URL` (finmate, anchor epic TSP-7853) and `JIRA_URL_2` (mypaytm, anchor
  epic TPAP-8885) if both are set (worklogs may live on either site), and
  **consolidate** the totals across both — this is a hard requirement, not an
  optional nicety, since the two anchors are where `/logwork` parks ad-hoc time
  by default. If only one is configured, use that one.
- Account id (fetch once per Jira base in play):
  ```bash
  ACCOUNT_ID=$(curl -s -u "$JIRA_EMAIL:$TOKEN" "$JIRA_BASE/rest/api/3/myself" | jq -r '.accountId // empty')
  ```
  If this returns empty for a given base (site unreachable this session —
  connector not granted, network policy block, etc.), skip that base for both
  dates rather than failing the whole digest, and record it as a skipped site
  to surface in Step 7 — never present a total as complete when a site
  couldn't be reached.

---

## Step 3 — Pull worklogged issues for each date

For each `$DATE` in (`$TODAY`, `$YESTERDAY`) and each `$JIRA_BASE` in play:

```bash
curl -s -G -u "$JIRA_EMAIL:$TOKEN" "$JIRA_BASE/rest/api/3/search/jql" \
  --data-urlencode "jql=worklogAuthor = \"$ACCOUNT_ID\" AND worklogDate = \"$DATE\"" \
  --data-urlencode "fields=summary,status" \
  | jq -r '.issues[] | [.key, .fields.summary, .fields.status.name] | @tsv'
```

For each returned issue key, get this user's total seconds on that date:

```bash
curl -s -u "$JIRA_EMAIL:$TOKEN" "$JIRA_BASE/rest/api/3/issue/$KEY/worklog" \
  | jq --arg acc "$ACCOUNT_ID" --arg date "$DATE" \
    '[.worklogs[] | select(.author.accountId == $acc and (.started | startswith($date))) | .timeSpentSeconds] | add // 0'
```

Build one row per issue: `Jira ID | Subject | Duration (Xh Ym) | Status`.
Sum all durations for the date → `TOTAL_<DATE>`.

If an issue key is not accessible on the base it wasn't found under, just skip
it silently for that base (it'll be found on the other base's pass instead).
If an entire base was unreachable (per Step 2), its worklogs are simply absent
from the merged rows/total for both dates — this is NOT silent at the report
level (see Step 7), only at the per-issue level above.

---

## Step 4 — Format the message

Two sections, one per date, newest first:

```
*Work Log Summary — Today (2026-07-14)*
| Jira ID | Subject | Duration | Status |
|---|---|---|---|
| TPAP-8889 | UPI and Auth central DSM 14 July | 1h 0m | Closed |
Total logged today: 1h 0m / 9h 0m

*Work Log Summary — Yesterday (2026-07-13)*
| Jira ID | Subject | Duration | Status |
|---|---|---|---|
| (none logged) | | | |
Total logged yesterday: 0h 0m / 9h 0m
```

If zero issues for a date, show a single "(none logged)" row rather than an
empty table.

---

## Step 5 — Send to Slack

```bash
jq -n --arg text "$SLACK_MESSAGE" '{text: $text}' > /tmp/logwork-summary-slack.json
curl -s -X POST -H "Content-Type: application/json" \
  "$SLACK_WEBHOOK_URL" -d @/tmp/logwork-summary-slack.json
rm -f /tmp/logwork-summary-slack.json
```

Skip this step (and note it in the final report) if `SLACK_WEBHOOK_URL` is unset.

---

## Step 6 — Send Email

Recipient comes from `LOGWORK_SUMMARY_TO` in `prd-agent/.env` — never hardcode
an email address in this skill file. If it's unset, skip this step (see Step 1).
Build a raw RFC822 message and upload it directly via curl's SMTP support
(STARTTLS on port 587) — no Node/nodemailer dependency, matches this skill's
self-contained curl style:

```bash
FROM_ADDR="${EMAIL_FROM:-$EMAIL_USER}"
PASS="${EMAIL_PASS:-$EMAIL_PASSWORD}"
{
  printf 'From: %s\r\n' "$FROM_ADDR"
  printf 'To: %s\r\n' "$LOGWORK_SUMMARY_TO"
  printf 'Subject: Daily Work Log Summary - %s\r\n' "$TODAY"
  printf 'Content-Type: text/html; charset=UTF-8\r\n'
  printf '\r\n'
  printf '%s\r\n' "$HTML_BODY"
} > /tmp/logwork-summary-email.txt

curl -s --url "smtp://${EMAIL_SMTP_HOST}:${EMAIL_SMTP_PORT:-587}" --ssl-reqd \
  --mail-from "$FROM_ADDR" --mail-rcpt "$LOGWORK_SUMMARY_TO" \
  --upload-file /tmp/logwork-summary-email.txt \
  --user "$EMAIL_USER:$PASS"

rm -f /tmp/logwork-summary-email.txt
```

`$HTML_BODY` is the same two-section summary as Step 4, rendered as simple
HTML tables (one `<table>` per date, header row Jira ID/Subject/Duration/
Status, a bold total line under each).

Skip this step (and note it in the final report) if `EMAIL_SMTP_HOST` or
`EMAIL_USER` is unset.

---

## Step 7 — Report

```
# Summary
Sent EOD work-log digest for <TODAY> and <YESTERDAY> (consolidated across
finmate + mypaytm) — <N> ticket(s) today (<TOTAL_TODAY>), <M> ticket(s)
yesterday (<TOTAL_YESTERDAY>).
Slack: <sent / skipped — reason>
Email: <sent / skipped — reason>
<If any Jira site was unreachable this run: "Note: <site> was unreachable — its worklogs are not included in the totals above.">

```

Keep this final message short — the full table already went out over
Slack/Email, no need to repeat it verbatim to the user unless they ask.

---

## Error handling

| Situation | Action |
|---|---|
| `JIRA_EMAIL`/token missing | Stop, tell user to set them in `prd-agent/.env` |
| Neither Slack nor Email configured | Stop, tell user which env vars are missing |
| Only one channel configured | Send to that one, note the other was skipped |
| Slack POST fails (non-2xx or curl error) | Still attempt Email, report Slack failure separately |
| Email curl SMTP send fails | Still report Slack result, surface the SMTP error (never print the password) |
| Zero worklogs for a date | Not an error — show "(none logged)" for that date, total 0h 0m |

Never print `JIRA_TOKEN`, `EMAIL_PASS`/`EMAIL_PASSWORD`, or `SLACK_WEBHOOK_URL`
in any output.

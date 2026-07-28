---
name: logwork
description: >
  Create a Jira sub-task and log actual time spent (worklog) against it, from five
  free-form inputs: Subject, Description, Start time, Meeting time (minutes), and
  JIRA ID. Trigger on `/logwork`, "log work", "log today's work", "log this meeting
  on Jira", or any request to record time spent against a Jira ticket. If no JIRA ID
  is given, default to TPAP-8885 (https://mypaytm.atlassian.net/browse/TPAP-8885).
  Drives the sub-task through Solution & Zeplin Review -> In Progress -> Closed
  itself (work is only ever logged while the sub-task is In Progress). Enforces a
  global 540 min/day (9h) worklog cap across ALL of the user's Jira worklogs that
  day, and reports remaining minutes for the day after every run. Talks to the Jira
  Cloud REST API directly via curl using credentials already in prd-agent/.env —
  does not modify prd-agent/backend/server.js, the prd-agent-tools MCP, or any
  other skill (/jiragenerator, /uatmaster,
  /tsp-compliance-service-jira-generator are untouched and unaffected). Companion
  skill /logwork-summary sends an end-of-day Slack+Email digest of the same data.
---

# /logwork — Jira Sub-task + Worklog Skill

Turn rough work notes into a Jira sub-task (for traceability) plus a real Jira
worklog entry (for time tracking), in one shot — driving the ticket through its
full In Progress -> Closed lifecycle and enforcing a daily time-logging cap.

**Scope note:** this skill is self-contained. It calls the Jira REST API directly
with `curl`, reading credentials from `prd-agent/.env` — it does **not** touch
`prd-agent/backend/server.js`, `prd-agent/mcp/prd-agent-tools/index.js`, or any
`.claude/commands/*.md` file. `/jiragenerator`, `/uatmaster`, and
`/tsp-compliance-service-jira-generator` keep working exactly as before. The
"show remaining time" behavior below applies ONLY inside this skill — it does
not touch `/jiragenerator` or comment-adding flows.

**Jira API note:** the legacy `/rest/api/3/search` endpoint is retired (HTTP 410).
Always use `/rest/api/3/search/jql` for JQL searches in this skill.

---

## Input

| Field | Required | Notes |
|---|---|---|
| Subject | Yes | Free text — becomes the sub-task summary |
| Description | Yes | Free text — raw notes, gets turned into a professional work log |
| Start time | Yes | Date + time the work started, e.g. `2026-07-14 09:00` or `9am today` |
| Meeting time | Yes | Minutes spent, e.g. `45` |
| JIRA ID | No | Parent issue to attach the sub-task to. Default: `TPAP-8885` (`https://mypaytm.atlassian.net/browse/TPAP-8885`) |

Never block on missing JIRA ID — apply the default. Only ask a clarifying question
if Subject, Description, Start time, or Meeting time is genuinely absent from the
request.

---

## Step 1 — Fill defaults

- No JIRA ID given → `JIRA_ID = TPAP-8885`.
- Parse Start time into a concrete datetime (resolve "today"/"yesterday"/"9am" against
  the current date). Assume IST (`+0530`) unless the user states another timezone.
- `LOG_DATE` = the date portion (`YYYY-MM-DD`) of the resolved Start time — the
  daily cap in Step 3 is keyed to the day the work happened, not "today", so a
  backdated log checks the cap for that backdated day.

---

## Step 2 — Generate the professional work log content

Apply the same discipline as "Generate Daily Work Log": convert rough notes into
professional prose using action verbs (Implemented, Validated, Tested, Analysed,
Designed, Reviewed, Optimized, Debugged, Verified, Documented, Integrated). Never
emit a vague log. Produce these five fields:

- **Time Spent** — meeting minutes formatted as `Xh Ym` or `Xm`
- **Professional Comment** — 2-4 sentences rewriting the raw Description
- **Summary** — one line, outcome-oriented
- **Blockers** — "None" unless the notes mention one
- **Next Steps** — a reasonable inferred continuation; tag `[TBD]` if truly not derivable

---

## Step 3 — One Bash call: load env, resolve routing, check the daily cap

**Token efficiency — read before executing anything below:** run each
numbered step (3, 4, 5) as ONE Bash tool call — chain commands with
`;`/`&&`/`|` inside a single call rather than splitting into several tool
calls. Always pipe Jira responses through `jq` to extract only the field(s)
needed; never let a raw response print unfiltered (worklog objects carry full
author/avatar blobs and are large — every unfiltered print burns real tokens
for no benefit, since only 1-2 fields are ever used downstream).

Read, but never print or log, these values from `~/prd-agent/backend/.env` (if
it exists) then `~/prd-agent/.env` (later file wins, matching how the backend
loads env — see repo `CLAUDE.md`). Only routing/lookup vars are needed here —
`JIRA_EMAIL`/`JIRA_TOKEN`/`JIRA_API_TOKEN` load independently inside the
wrapper script, so they never need to appear in a command this skill runs.
**Every Jira API call in this skill goes through
`~/.claude/skills/logwork/jira-curl.sh` instead of raw `curl -u ...`** — it
injects `-u "$JIRA_EMAIL:$TOKEN"` itself. If it exits non-zero (missing
`JIRA_EMAIL`/token), stop and tell the user to set them in `prd-agent/.env`
(same file the web Jira Agent uses).

Site routing replicates the backend's `resolveJiraBaseForWrite` (read-only
reference, not modified): `PROJECT_KEY` = the part of `JIRA_ID` before the
`-`; if it's in `JIRA_SECONDARY_PROJECT_KEYS` (env, default `TPAP,PCO,TPG`) →
base = `JIRA_URL_2` (fallback `JIRA_URL`); otherwise base = `JIRA_URL`
(fallback `JIRA_URL_2`). If both empty, stop and ask the user to configure
`JIRA_URL_2` (for `TPAP-8885` this is `https://mypaytm.atlassian.net`).

Sub-task issue type for project `TPAP` is known to be `10038` — use it
directly rather than re-querying `createmeta` on every run; only fall back to
the live lookup (`.../issue/createmeta?projectKeys=$PROJECT_KEY&expand=projects.issuetypes`,
`jq -r '.projects[0].issuetypes[] | select(.subtask==true) | .id'`) if a
create call later fails with an invalid-issuetype error, or if `PROJECT_KEY`
isn't `TPAP`. `$JIRA_SUBTASK_ISSUE_TYPE_NAME` from env overrides if set.

All of the above, plus the daily-cap arithmetic, in one call:

```bash
for f in ~/prd-agent/backend/.env ~/prd-agent/.env; do
  [ -f "$f" ] && export $(grep -E '^(JIRA_URL|JIRA_URL_2|JIRA_URL_SECONDARY|JIRA_URL_TPAP|JIRA_SECONDARY_PROJECT_KEYS|JIRA_SUBTASK_ISSUE_TYPE_NAME)=' "$f" | xargs -0 2>/dev/null || true)
done
PROJECT_KEY="${JIRA_ID%%-*}"
case ",${JIRA_SECONDARY_PROJECT_KEYS:-TPAP,PCO,TPG}," in
  *",${PROJECT_KEY},"*) JIRA_BASE="${JIRA_URL_2:-$JIRA_URL}" ;;
  *) JIRA_BASE="${JIRA_URL:-$JIRA_URL_2}" ;;
esac
SUBTASK_TYPE_ID="${JIRA_SUBTASK_ISSUE_TYPE_NAME:-10038}"

ACCOUNT_ID=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/myself" | jq -r '.accountId')
KEYS=$(~/.claude/skills/logwork/jira-curl.sh -G "$JIRA_BASE/rest/api/3/search/jql" \
  --data-urlencode "jql=worklogAuthor = \"$ACCOUNT_ID\" AND worklogDate = \"$LOG_DATE\"" \
  --data-urlencode "fields=summary" | jq -r '.issues[].key')
EXISTING_SECONDS=0
# while-read, not `for K in $KEYS` — the latter silently fails to split on
# newlines under zsh (no shwordsplit), collapsing all keys into one bogus
# iteration and reporting EXISTING_SECONDS=0. while-read is portable.
while IFS= read -r K; do
  [ -n "$K" ] || continue
  SECS=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/issue/$K/worklog" \
    | jq --arg acc "$ACCOUNT_ID" --arg date "$LOG_DATE" \
      '[.worklogs[] | select(.author.accountId == $acc and (.started | startswith($date))) | .timeSpentSeconds] | add // 0')
  EXISTING_SECONDS=$((EXISTING_SECONDS + SECS))
done <<< "$KEYS"
REMAINING_BEFORE=$((32400 - EXISTING_SECONDS))
echo "JIRA_BASE=$JIRA_BASE PROJECT_KEY=$PROJECT_KEY SUBTASK_TYPE_ID=$SUBTASK_TYPE_ID ACCOUNT_ID=$ACCOUNT_ID EXISTING_SECONDS=$EXISTING_SECONDS REMAINING_BEFORE=$REMAINING_BEFORE"
```

`CAP_SECONDS = 32400` (540 min). This is a **global** rule — counts every
worklog the user logged that day across ALL Jira tickets, not just ones this
skill created. **If `TIME_SPENT_SECONDS > REMAINING_BEFORE`**: stop here, do
not create the sub-task. Report minutes already logged, minutes remaining,
and the shortfall — hard block, not a warning. Otherwise continue;
`REMAINING_AFTER = REMAINING_BEFORE - TIME_SPENT_SECONDS` for the final report.

---

## Step 4 — One Bash call: create sub-task, transition to In Progress, log the worklog

Build the description as a simple ADF doc (plain paragraphs — this is a
work-log entry, not a full spec, so skip the heavy Background/Objective/AC
template used for feature sub-tasks). Always set **Original Estimate = `1d`**
(placeholder, not a real estimate — Jira requires it present before a To
Do-category status can transition to In Progress, same reason the
`resolution` field matters below). Set **Fin_Business Cost Center = "UPI"**
(`customfield_10182`, option id `10240`) only when `$JIRA_BASE` resolves to
`$JIRA_URL_2` — that field only exists with this meaning on
`mypaytm.atlassian.net` (confirmed against `TPAP-8928`); sending it to
`$JIRA_URL` risks an invalid-customfield error.

**A Jira transition can return HTTP 204 "success" and still not land on the
target status** — if the transition has required fields we didn't supply
(commonly `resolution`), Jira silently redirects to a validation status like
"MANDATORY FIELDS MISSING". Never trust the 204 alone; always verify the
resulting status, and only log the worklog once verified `"in progress"`.

One call, filtered output only (`.key`, transition id, status name, worklog
id/time — never the raw Jira response bodies):

```bash
jq -n \
  --arg subject "$SUBJECT" --arg timeSpent "$TIME_SPENT" --arg comment "$PROFESSIONAL_COMMENT" \
  --arg summary "$SUMMARY" --arg blockers "$BLOCKERS" --arg next "$NEXT_STEPS" \
  --arg parentKey "$JIRA_ID" --arg subtaskTypeId "$SUBTASK_TYPE_ID" --arg projectKey "$PROJECT_KEY" \
  --argjson costCenter "$([ "$JIRA_BASE" = "$JIRA_URL_2" ] && echo '[{"id":"10240"}]' || echo 'null')" \
  '{ fields: ({
       project: { key: $projectKey }, parent: { key: $parentKey }, issuetype: { id: $subtaskTypeId },
       summary: $subject, timetracking: { originalEstimate: "1d" },
       description: { type:"doc", version:1, content: [
         {type:"paragraph", content:[{type:"text", text: ("Time Spent: " + $timeSpent)}]},
         {type:"paragraph", content:[{type:"text", text: $comment}]},
         {type:"paragraph", content:[{type:"text", text: ("Summary: " + $summary)}]},
         {type:"paragraph", content:[{type:"text", text: ("Blockers: " + $blockers)}]},
         {type:"paragraph", content:[{type:"text", text: ("Next Steps: " + $next)}]}
       ]}
     } + (if $costCenter != null then {customfield_10182: $costCenter} else {} end)) }' \
  > /tmp/logwork-create.json

CREATE_RESP=$(~/.claude/skills/logwork/jira-curl.sh -X POST -H "Content-Type: application/json" \
  "$JIRA_BASE/rest/api/3/issue" -d @/tmp/logwork-create.json)
NEW_KEY=$(echo "$CREATE_RESP" | jq -r '.key // empty')
if [ -z "$NEW_KEY" ]; then echo "CREATE_FAILED: $(echo "$CREATE_RESP" | jq -c '.errorMessages // .errors // .')"; exit 1; fi

TRANSITION_ID=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions" \
  | jq -r '.transitions[] | select(.to.name | ascii_downcase == "in progress") | .id' | head -1)
if [ -z "$TRANSITION_ID" ]; then echo "NEW_KEY=$NEW_KEY NO_IN_PROGRESS_TRANSITION"; exit 1; fi

REQUIRED_FIELDS=$(~/.claude/skills/logwork/jira-curl.sh \
  "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions?transitionId=$TRANSITION_ID&expand=transitions.fields" \
  | jq -r '.transitions[0].fields | to_entries[] | select(.value.required==true) | .key')
if echo "$REQUIRED_FIELDS" | grep -qx resolution; then
  RESOLUTION_ID=$(~/.claude/skills/logwork/jira-curl.sh \
    "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions?transitionId=$TRANSITION_ID&expand=transitions.fields" \
    | jq -r '.transitions[0].fields.resolution.allowedValues[] | select(.name=="Unresolved") | .id')
  PAYLOAD="{\"transition\": {\"id\": \"$TRANSITION_ID\"}, \"fields\": {\"resolution\": {\"id\": \"$RESOLUTION_ID\"}}}"
else
  PAYLOAD="{\"transition\": {\"id\": \"$TRANSITION_ID\"}}"
fi
~/.claude/skills/logwork/jira-curl.sh -X POST -H "Content-Type: application/json" \
  "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions" -d "$PAYLOAD" > /dev/null

ACTUAL_STATUS=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/issue/$NEW_KEY?fields=status" | jq -r '.fields.status.name')

if [ "$(echo "$ACTUAL_STATUS" | tr '[:upper:]' '[:lower:]')" = "in progress" ]; then
  jq -n --arg started "$STARTED_ISO" --arg comment "$PROFESSIONAL_COMMENT" --argjson secs "$TIME_SPENT_SECONDS" \
    '{ started: $started, timeSpentSeconds: $secs,
       comment: { type:"doc", version:1, content:[{type:"paragraph", content:[{type:"text", text: $comment}]}] } }' \
    > /tmp/logwork-worklog.json
  WL_RESP=$(~/.claude/skills/logwork/jira-curl.sh -X POST -H "Content-Type: application/json" \
    "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/worklog" -d @/tmp/logwork-worklog.json)
  echo "NEW_KEY=$NEW_KEY ACTUAL_STATUS=$ACTUAL_STATUS WORKLOG_ID=$(echo "$WL_RESP" | jq -r '.id // empty') TIME_SPENT=$(echo "$WL_RESP" | jq -r '.timeSpent // empty')"
else
  echo "NEW_KEY=$NEW_KEY ACTUAL_STATUS=$ACTUAL_STATUS STILL_REQUIRED=$(echo "$REQUIRED_FIELDS" | tr '\n' ',')"
fi
```

Normalize Start time to Jira's format (`YYYY-MM-DDTHH:mm:ss.SSS±HHMM`, e.g.
`2026-07-14T09:00:00.000+0530`) for `$STARTED_ISO` before running this.

If `CREATE_FAILED`, stop and surface Jira's message verbatim (never invent a
success). If `NO_IN_PROGRESS_TRANSITION`, stop before logging work — surface
the workflow gap. If `ACTUAL_STATUS` isn't `"In Progress"` even with the
resolution default applied, stop before logging work — report `STILL_REQUIRED`
(fields beyond summary/parent/resolution) and let the user resolve them in
Jira; don't guess values for fields with no safe default.

---

## Step 5 — One Bash call: transition to "Closed", verify, clean up

Once the worklog is in, close the ticket out — fetch a fresh transitions list
(it changes now that status is In Progress) and pick "Closed". Same
required-fields + verify-don't-trust-204 pattern as Step 4; `resolution`
defaults to `"Done"` here (work is actually finished), not `"Unresolved"`.

```bash
TRANSITION_ID=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions" \
  | jq -r '.transitions[] | select(.to.name | ascii_downcase == "closed") | .id' | head -1)
REQUIRED_FIELDS=$(~/.claude/skills/logwork/jira-curl.sh \
  "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions?transitionId=$TRANSITION_ID&expand=transitions.fields" \
  | jq -r '.transitions[0].fields | to_entries[] | select(.value.required==true) | .key')
if echo "$REQUIRED_FIELDS" | grep -qx resolution; then
  RESOLUTION_ID=$(~/.claude/skills/logwork/jira-curl.sh \
    "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions?transitionId=$TRANSITION_ID&expand=transitions.fields" \
    | jq -r '.transitions[0].fields.resolution.allowedValues[] | select(.name=="Done") | .id')
  PAYLOAD="{\"transition\": {\"id\": \"$TRANSITION_ID\"}, \"fields\": {\"resolution\": {\"id\": \"$RESOLUTION_ID\"}}}"
else
  PAYLOAD="{\"transition\": {\"id\": \"$TRANSITION_ID\"}}"
fi
~/.claude/skills/logwork/jira-curl.sh -X POST -H "Content-Type: application/json" \
  "$JIRA_BASE/rest/api/3/issue/$NEW_KEY/transitions" -d "$PAYLOAD" > /dev/null
ACTUAL_STATUS=$(~/.claude/skills/logwork/jira-curl.sh "$JIRA_BASE/rest/api/3/issue/$NEW_KEY?fields=status" | jq -r '.fields.status.name')
echo "NEW_KEY=$NEW_KEY ACTUAL_STATUS=$ACTUAL_STATUS"
rm -f /tmp/logwork-create.json /tmp/logwork-worklog.json
```

If `ACTUAL_STATUS` isn't `"Closed"` — don't hide the worklog success — report
the sub-task key/worklog id as done, then show which required field(s) are
still blocking the close transition separately (same partial-success
principle as Step 4).

---

## Step 6 — Report

Follow the standard structured output format, adapted for a work-log entry:

```
# Summary
Logged <Time Spent> against <NEW_KEY> (sub-task of <JIRA_ID>). Status: In Progress -> Closed.

# Generated Jira

## Title
<Subject>

## Description
**Time Spent:** <Xh Ym>
**Professional Comment:** <...>
**Summary:** <...>
**Blockers:** <None / ...>
**Next Steps:** <...>

## Acceptance Criteria
N/A — this is a work-log entry, not a deliverable ticket.

## Dependencies
Parent: <JIRA_ID> — <jira_base>/browse/<JIRA_ID>

## Assumptions
<any inferred defaults — timezone, next steps, etc.>

## Daily cap
Logged on <LOG_DATE>: <existing + new, formatted Xh Ym> / 9h 0m used.
Remaining today: <REMAINING_AFTER, formatted Xh Ym>.

## SOP Validation
✓ Parent — <JIRA_ID>
✓ Worklog logged same day as work performed
✓ Sub-task created: <NEW_KEY> — <jira_base>/browse/<NEW_KEY>
✓ Time tracked: <Time Spent>
✓ Status driven: Solution & Zeplin Review -> In Progress -> Closed
```

Give the sub-task key, browse URL, confirm the worklog id from Jira's response,
and always state remaining minutes for the day — before finishing.

---

## Error handling

| Situation | Action |
|---|---|
| `JIRA_EMAIL`/token missing | Stop, tell user to set them in `prd-agent/.env` |
| Neither `JIRA_URL` nor `JIRA_URL_2` resolves for the project key | Stop, ask user to set the right one |
| Daily cap: this entry would exceed 540 min for `LOG_DATE` | Hard stop before creating anything. Report minutes already logged, minutes remaining, and the shortfall |
| Sub-task issue type lookup returns nothing | Fall back to `{"name": "Sub-task"}` |
| Create call returns `errorMessages`/`errors` | Surface Jira's exact error, do not retry silently |
| No transition to "In Progress" found from create status | Stop before logging work — surface the workflow gap, do not log time in the wrong status |
| Transition to "In Progress" returns 204 but `ACTUAL_STATUS` isn't "In Progress" (e.g. bounced to "MANDATORY FIELDS MISSING" because `resolution` or another required field wasn't set) | Stop before logging work. Retry once with `resolution: Unresolved` if that's the missing field; if another required field is still missing, surface exactly which one and don't guess a value. Original Estimate is pre-set at create time (Step 4) specifically to avoid this being the cause |
| Worklog call fails after sub-task was created successfully | Still report the created sub-task key/URL, then show the worklog error separately — don't hide a partial success |
| No transition to "Closed" found after logging work | Still report the sub-task key/worklog id as done, then show the close-transition error separately |
| Transition to "Closed" returns 204 but `ACTUAL_STATUS` isn't "Closed" | Same pattern as the In Progress case — retry once with `resolution: Done` if that's the missing field, otherwise report the sub-task/worklog as done and surface the specific blocking field |

Never print `JIRA_TOKEN` or the raw `Authorization` header in any output.

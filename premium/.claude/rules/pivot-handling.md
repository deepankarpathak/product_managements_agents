# Pivot Handling

When the PM's input mid-skill signals intent for a different skill (or a different mode of the same skill), do not switch silently. Fire a pivot gate.

## Hard pivot — different skill

Definition: PM's language signals a different skill while one is active.

Example: PM is in `/investigate` Phase 3, says "actually, let's step back to `/explore` for the broader funnel."

Action:
1. Acknowledge the requested switch.
2. State the current skill state ("currently in `/investigate` Phase 3, testing H-002").
3. Offer three options:
   - **(a) park** — save current state, can resume later (artifacts written as IN-PROGRESS or SUSPENDED).
   - **(b) abandon** — drop progress, start fresh (no artifacts persisted from current run).
   - **(c) finish** — complete current task first, then pivot.
4. PM picks. Then execute.
5. Log the pivot decision in the session log: "PM pivoted from `/investigate` H-002 → `/explore` on 2026-05-07. Choice: park."

## Soft pivot — different mode in same skill

Definition: PM signals mode change within the active skill.

Example: PM in `/investigate` hypothesis mode says "actually, let's look at this from the signal angle instead." Stays in `/investigate`, but Phase 1 frame restarts.

Action: auto-allowed with a one-line acknowledgement. No formal gate. "Switching to signal mode. Phase 1 reframe."

## Why pivots are gated

- **State integrity** — artifacts in working state should be saved or explicitly discarded, not lost silently.
- **Audit trail** — pivot reasons captured in session log.
- **Anti-thrash** — sometimes the pivot is a mistake; the gate gives PM a chance to reconsider.

## Pivot signal detection

Pivot signal = PM language matches a different skill's trigger phrases (per `skill-triggers.md`) while a skill is currently active.

## Per-skill pivot exceptions

None for v1. All pivots use the same gate.

---
name: gated-goal
description: Use when the user invokes /gated-goal to start a plan-act-review loop with a frozen, tamper-proof plan and an independent reviewer subagent that gates completion. Four phases — select reviewer, plan (freeze), act (work todos), review (reviewer verifies against frozen plan). The loop repeats until the reviewer emits <promise>DONE</promise> or max-iteration is reached.
---

# Gated-goal mode

A four-phase workflow that gates task completion behind an independent review
against a frozen plan. Started by the user with `/gated-goal`.

## Starting

`/gated-goal [maxIteration] [reviewerModel]`
- `maxIteration` — default 10. Max number of review rounds before bailing.
- `reviewerModel` — `provider/modelId`. If omitted, a model picker opens; esc
  defaults to the main agent's current model.

## Phases

### P1 — select reviewer
Pick/connect the reviewer. A connectivity probe ("reply ok") runs first; if it
fails, gated-goal aborts automatically. The reviewer is a subagent — it shows
in `/subagents`, emits waits, and **cannot dispatch sub-subagents**.

### P2 — plan
Discuss the goal with the user until they explicitly confirm. Then call
`freeze_plan` with four sections and the todo list:
- `outcome` — concrete things the task must achieve
- `verification` — commands/tools to check success (e.g. `npm test`, curl)
- `constraints` — what must not happen (files not to touch, data not to alter)
- `quality` — bars (unit tests, CI green, etc.)
- `todos` — work items, become the ACT-phase todo list

`freeze_plan` hashes the plan and enters ACT. **Only call it after explicit
user confirmation.** The frozen prompt is immutable for the rest of the run.

### P3 — act
Work the todos. When you stop:
- if all todos are done → the reviewer runs automatically (→ P4)
- if todos remain → the todo nudge fires; keep going (stay in P3)

So: mark items done as you finish, and stop only when the work is complete.

### P4 — review
The reviewer subagent re-checks the work against the **frozen** plan and runs
the verification commands. Two outcomes:
- It outputs `<promise>DONE</promise>` → control passes to you for VERIFY (P5).
  **Do not exit yet** — reviewers can rubber-stamp.
- It lists required changes → they come back to you as a follow-up; iteration
  counter ticks; go back to P3. The next review is a **fresh** reviewer
  context (only the frozen plan carries over, not prior review chatter).

If iterations reach `maxIteration` without a DONE → gated-goal exits, reason
**max iteration reached**.

### P5 — verify (your independent check)
Only reached after the reviewer says DONE. You must independently re-run the
frozen verification commands yourself and **subjectively judge** whether the
work genuinely satisfies the plan — reviewers sometimes approve without
actually checking. Then:
- `confirm_done` (optional note) → gated-goal exits, reason **done**.
- `reject_done` (reason) → counts as a used iteration; your reason becomes
  ACT feedback; back to P3. If this pushes iterations to `maxIteration` →
  exit (max iteration reached).

This is the final gate. The reviewer's promise is necessary but not
sufficient — your own verification is what closes the loop.

## Integrity

The frozen plan is hashed and stored. At every review the hash is recomputed;
on mismatch the archived plan is still used — mismatch never exits the gate
(tampering cannot abort it).

## Aborting

`/gated-goal-exit` aborts manually.

## Notes

- The reviewer has read-only + bash tools (can run tests, can't edit). It is a
  subagent, so it obeys the same `wait:active`/`wait:done` protocol as
  dispatch — todo nudges stay silent while it runs.
- You can still dispatch your own subagents in P3 for exploration/implementation
  (subject to constraints you wrote into the plan).

---
name: gated-goal
description: Use when the user invokes /gated-goal to start a plan-act-review loop with a frozen, hash-checked plan and an independent reviewer subagent that gates completion. Five phases — select reviewer, plan (freeze), act (work todos), review (reviewer checks against the frozen plan), verify (you re-run the verification yourself). The loop repeats until you confirm completion or max-iteration is reached.
---

# Gated-goal mode

A five-phase workflow that gates task completion behind an independent review
against a frozen plan, plus your own verification pass. Started by the user
with `/gated-goal`.

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
- `todos` — work items. These **replace** your todo list, so include everything
  ACT needs and do not re-add them afterwards.

`freeze_plan` hashes the plan and enters ACT. **Only call it after explicit
user confirmation.** The frozen prompt is immutable for the rest of the run.

### P3 — act
Work the todos (they are already there — freeze_plan created them). The frozen
plan must contain at least one todo before ACT can begin. When you stop, the
todo extension alone decides what follows:
- a fresh incomplete list gets one continuation nudge (stay in P3)
- an active external wait stays in P3 without a nudge
- if no continuation is scheduled — including an empty list, an all-done list,
  or an unchanged incomplete list that was already nudged — review starts (→ P4)

So: mark items done as you finish. You may clear the list when the work is
complete; reviewer feedback can create fresh todos for the next ACT round.

### P4 — review
The reviewer subagent re-checks the work against the **frozen** plan and runs
the verification commands. The iteration counter ticks on either outcome — a
review that ran is spent regardless of its verdict. Then:
- It starts a line with `<promise>DONE</promise>` → control passes to you for
  VERIFY (P5), even if that was the last allowed iteration. **Do not exit yet**
  — reviewers can rubber-stamp.
- It lists required changes → they come back to you as a follow-up; go back to
  P3. The next review is a **fresh** reviewer context (only the frozen plan
  carries over, not prior review chatter).

If a review asks for changes and the counter has reached `maxIteration` →
gated-goal exits, reason **max iteration reached**.

### P5 — verify (your independent check)
Only reached after the reviewer says DONE. You must independently re-run the
frozen verification commands yourself and **subjectively judge** whether the
work genuinely satisfies the plan — reviewers sometimes approve without
actually checking. Then:
- `confirm_done` (optional note) → gated-goal exits, reason **done**.
- `reject_done` (reason) → your reason becomes ACT feedback; back to P3. The
  iteration was already charged when the review ran, so rejecting costs no
  extra budget — but if that was the last allowed iteration, rejecting ends the
  run (**max iteration reached**).

This is the final gate. The reviewer's promise is necessary but not
sufficient — your own verification is what closes the loop.

## Integrity

The frozen plan is hashed and stored, and archived separately in the session.
At every review the hash is recomputed; on mismatch the archived copy is
reviewed instead and you are told in the feedback. A mismatch never exits the
gate, so editing the plan cannot be used to abort the workflow.

## Aborting

`/gated-goal-exit` aborts manually.

## Notes

- The reviewer gets read-only tools plus bash (so it can run tests and `git
  diff`) and no write/edit tools, and starts without the project's
  `AGENTS.md`/`CLAUDE.md` — its standard is the frozen plan alone. It is a
  subagent, so it obeys the same `wait:active`/`wait:done` protocol as dispatch
  — todo nudges stay silent while it runs.
- You can still dispatch your own subagents in P3 for exploration/implementation
  (subject to constraints you wrote into the plan).

---
name: gated-goal
description: Use when the user invokes /gated-goal to start a plan-act-review loop with a frozen, hash-checked plan and an independent reviewer subagent that gates completion. Six phases — select reviewer, plan, freeze (the reviewer audits your plan against the conversation), act (work todos), review (reviewer checks against the frozen plan), verify (you re-run the verification yourself). The loop repeats until you confirm completion or max-iteration is reached.
---

# Gated-goal mode

A six-phase workflow that gates task completion behind an independent review
against a frozen plan, plus your own verification pass — and gates the freezing
of that plan behind the same reviewer. Started by the user with `/gated-goal`.

## Starting

`/gated-goal [maxIteration] [reviewerModel]`
- `maxIteration` — default 10. Max number of review rounds before bailing.
- `reviewerModel` — `provider/modelId`. If omitted, a searchable model picker
  opens (type to filter, ↑↓/jk move, pgup/pgdn/home/end jump); esc defaults to
  the main agent's current model.
- Already active? Confirming "Abort and start over" tears the old gate down
  immediately — even if the new reviewer's ping then fails, nothing stays
  active.

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

`freeze_plan` submits the plan — sections **and todos** — to the intent reviewer
(next phase) and, once approved, hashes it and enters ACT. **Only call it
after the user has seen the plan and explicitly confirmed it.** The frozen
prompt is immutable for the rest of the run.

### P2.5 — freeze (intent review)
The reviewer reads this session's transcript and audits the plan against what
the user actually asked for: does it add anything they did not ask for, drop
anything they did, or silently decide something that still needs their answer?
Todos are judged exactly like the sections.

- **Approved** → the plan is frozen and you are in ACT.
- **Rejected** → `freeze_plan` returns an error with the reviewer's reasons
  (intent mismatches, questions to ask the user) and you are back in P2.
  Relay the questions to the user in your own words, adjust the plan to their
  answers, then call `freeze_plan` again. Re-submitting an unchanged plan does
  not help: the reviewer rejects it again and every rejection counts.
- After `maxIteration` consecutive rejections the error says the **next**
  `freeze_plan` call skips the review. That is the loop's safety valve, not a
tactic to aim for.
- A review that timed out or could not run is not a rejection: tell the user
  what happened before trying again.

### P3 — act
Work the todos (they are already there — freeze_plan created them). The frozen
plan must contain at least one todo before ACT can begin. When you stop, the
todo extension alone decides what follows:
- a fresh incomplete list gets one continuation nudge (stay in P3)
- an active external wait stays in P3 without a nudge — including with every
  todo already done (a run that still waits on something is not finished)
- if no continuation is scheduled — including an empty list, an all-done list,
  or an unchanged incomplete list that was already nudged — review starts (→ P4)

So: mark items done as you finish. You may clear the list when the work is
complete; reviewer feedback can create fresh todos for the next ACT round.

Each time the gate sends you back to ACT (reviewer feedback, a rejected
approval), the completion nudge is re-armed and the message asks you to
reconcile the list with the feedback. Do that first: mark what is finished, add
the required changes, drop what is obsolete — then work the list.

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
frozen verification commands yourself (the handoff includes the complete
multiline Verification section) and **subjectively judge** whether the
work genuinely satisfies the plan — reviewers sometimes approve without
actually checking. Then:
- `confirm_done` (optional note) → gated-goal exits, reason **done**.
- `reject_done` (reason) → your reason becomes ACT feedback; back to P3. The
  iteration was already charged when the review ran, so rejecting costs no
  extra budget — but if that was the last allowed iteration, rejecting ends the
  run (**max iteration reached**).

This is the final gate. The reviewer's promise is necessary but not
sufficient — your own verification is what closes the loop. If you stop
without calling either tool, you are nudged to decide; the nudge itself does
not advance the gate.

## Integrity

The frozen plan is hashed and stored, and archived separately in the session.
At every review the hash is recomputed; on mismatch the archived copy is
reviewed instead and you are told in the feedback. A mismatch never exits the
gate, so editing the plan cannot be used to abort the workflow.

## Aborting

`/gated-goal-exit` aborts manually: the gate flips to idle immediately, the
in-flight reviewer is killed, and any reviewer result that arrives after the
exit is discarded — the loop cannot resurrect itself after an abort.

## Restart

If Pi restarts mid-review, that review's verdict never landed: it is **not
charged**, you are flipped back to ACT and told so. Re-present your completion
summary and stop — a fresh review runs automatically. The same applies to an
intent review that was in flight: you are back in PLAN, nothing counted —
call `freeze_plan` again.

## Notes

- The reviewer gets read-only tools plus bash (so it can run tests and `git
  diff`) and no write/edit tools, and starts without the project's
  `AGENTS.md`/`CLAUDE.md` — its standard is the frozen plan alone. It is a
  subagent, so it obeys the same `wait:active`/`wait:done` protocol as dispatch
  — todo nudges stay silent while it runs.
- You can still dispatch your own subagents in P3 for exploration/implementation
  (subject to constraints you wrote into the plan).

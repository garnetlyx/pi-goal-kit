---
name: todo
description: Use to track multi-step work with a task list. Create todos for the steps of a task, mark them pending when you start and done the moment each finishes. The list shows as a widget below the editor while non-empty. If you stop with todos still incomplete (and nothing is being waited on — no running subagent, no pending reminder), you get nudged to verify which are actually done and continue the rest. Always mark work done as soon as it is finished.
---

# Todo list

Track multi-step work. Add a todo per step, flip to `pending` when you start
it, flip to `done` the instant it is finished. The list renders as a widget
below the editor while non-empty, and stays visible even when everything is
done so the user can see what was accomplished — use `clear` to empty it.

## Why it exists

Local models often stop mid-work or finish but forget to mark items done. The
list makes progress visible, and a completion nudge catches both cases: if you
stop with incomplete todos and nothing else is being waited on, you receive a
follow-up telling you to verify which are done and continue the rest.

## The `todo` tool

```
todo({ action: "add", text: "..." })                         → creates with status "todo"
todo({ action: "set", id: <n>, status: "pending"|"done"|"todo" })
todo({ action: "list" })
todo({ action: "remove", id: <n> })
todo({ action: "clear" })
```

Statuses:
- `todo` — not started
- `pending` — in progress / blocked
- `done` — complete

`todo` and `pending` both count as incomplete and will trigger the nudge.

## When to use

- Any task with 2+ discrete steps — add them up front, work the list.
- When you finish a step, immediately `set` it `done`. Do not batch updates at the end.
- If you discover sub-steps mid-work, `add` them.

## The completion nudge

When you stop (`agent_settled`) with incomplete todos and there is no active
wait in flight (no running subagent, no pending reminder, no other extension
emitting `wait:active`), you receive a follow-up like:

> ⏫ 3 todo(s) still incomplete:
>   [todo] #1 ...
>   [pending] #2 ...
> First verify which are actually finished (a common mistake is completing
> work but forgetting to mark it done) — toggle finished ones via
> todo({action:"set", id:<n>, status:"done"}). Then continue any genuinely
> unfinished work.

This is by design: it catches local models that stop early and also reminds
you to mark work you already completed. Respond by toggling anything that is
actually done, then continuing the rest.

The nudge stays silent while a subagent or reminder is in flight so it does
not interrupt legitimate waits. The de-dup signature prevents repeat nudges
when nothing has changed since the last one. After each settle, todo publishes
its shared disposition for workflow extensions: `continue` when it sent a
nudge, `wait` while external work is active, or `review` when it scheduled no
continuation. Consumers must reuse that disposition rather than duplicate
todo, wait, or nudge logic.

## Persistence

The list is stored in tool-result details (not external files), so it is
automatically correct for the current branch — forking or navigating the
session tree restores the state as of that point in history.

Long lists (10+ items) are folded in the below-editor widget — done items
first, then the earliest — with a `… N hidden — /todos for all` summary line.
`/todos` opens a scrollable popup showing every item.

# Todo

A task list tool with a persistent editor-below widget and a completion nudge.
The agent tracks multi-step work via the `todo` tool; statuses are `todo` /
`pending` / `done`. If the agent stops (`agent_settled`) with incomplete todos
and no other extension is reporting an active wait, a follow-up message
nudges it to verify which are done and continue the rest — catching the common
local-model failure of stopping mid-work or forgetting to mark work done.

## How it works

```
agent uses todo tool → state stored in tool-result details
                    → widget below editor refreshes (non-empty only)

agent_settled fires (order matters: a wait outranks a finished list)
  if activeWaits.size > 0:
     → emit todo:settled { disposition: "wait" }        # nothing else, even with every todo done
  incomplete = todos where status != "done"
  if incomplete set is fresh:
     → pi.sendUserMessage(nudge, { deliverAs: "followUp" })
     → emit todo:settled { disposition: "continue" }
  else:
     → emit todo:settled { disposition: "review" }
```

The `followUp` delivery queues behind any active conversation and triggers a
new turn when the agent is idle — so the nudge never interrupts, and the agent
really does continue (costing tokens; this is intentional).

## Files

| Path | Purpose |
|------|---------|
| `extensions/todo/index.ts` | `todo` tool, `/todos` command, `agent_settled` hook, active-wait listener, below-editor widget |
| `extensions/todo/panel.ts` | `/todos` popup — windowed scrollable overlay showing the whole list |
| `extensions/todo/SKILL.md` | agent-facing instructions |

## `todo` tool

```
todo({ action: "add"|"list"|"set"|"remove"|"clear", text?, id?, status? })
```

- `add` (text) — creates with status `todo`
- `set` (id, status) — changes status to `todo` | `pending` | `done`
- `remove` (id) — deletes
- `clear` — empties the list
- `list` — returns current state

State is carried in the tool result's `details` field. `session_start` and
`session_tree` rebuild `todos` / `nextId` from the branch via
`readTodoSnapshot()` (`snapshot.ts`), so the list is always correct for the
active branch point.

`snapshot.ts` is the shared contract module: its read model walks the branch
and takes the last of either a `todo` tool result or a `todo-state` custom
entry; it also exports the replacement and settle event names and payload
types. It is pure on purpose — Pi gives each extension entry point its own
module instance, so shared *state* would silently split, while shared functions
and event contracts remain safe.

## Wholesale replacement (`todo:replace`)

```
pi.events.emit("todo:replace", { source, items: [{text, status?}], ctx })
```

Replaces the entire list in one step, renumbering ids from 1, and persists the
result with `pi.appendEntry("todo-state", …)` so it survives restarts and
branch navigation exactly like a tool result.

This exists for extensions that own a plan — `gated-goal`'s `freeze_plan` — and
need the list to *be* that plan. Instructing the model to "now add these todos"
instead appends them to whatever it wrote down earlier, producing duplicate
work and misleading progress.

## Re-arming the nudge (`todo:nudge-reset`)

```
pi.events.emit("todo:nudge-reset", { source })
```

Clears the nudge de-duplication signature (see Completion nudge) without touching
the list. It is for a workflow extension that hands the agent new work while the
list stays as it is — gated-goal relaying reviewer feedback — so that the next
stop with an incomplete list is nudged once again instead of going straight to
the workflow's completion path. Without it the list was mentioned exactly once
per gate: the first nudge, then `review` forever, because nothing ever changed
the incomplete-id set. The same de-duplication bounds it: one nudge per
emission, never a loop.

## Widget

`ctx.ui.setWidget("todo", lines, { placement: "belowEditor" })` whenever the
list changes. Empty list clears the widget (`setWidget("todo", undefined)`);
a fully-done list stays visible (folded to the latest done items) so the user
can see what was accomplished this round. `clear` empties it.
Each line: `<glyph> #<id> <text>` where glyph is `○` (todo), `◐` (pending),
`✓` (done, dimmed).

pi's interactive mode renders at most 10 widget lines per widget and cuts the
tail beyond that (`... (widget truncated)`). The widget budgets itself to stay
under the cap (`MAX_WIDGET_LINES` in `index.ts`): up to 9 items fit whole; a
longer list is folded to 8 items plus a dim summary line — `done` items are
dropped first (the header already counts them), then the earliest items, so
the latest incomplete work stays visible (`chooseWidgetWindow`, pure, exported
for tests). The summary reads e.g. `… 3 done, 2 earlier hidden — /todos for
all`.

## `/todos` popup

`/todos` opens the full-list view in `panel.ts`: a `ctx.ui.custom` overlay in
the same visual pattern as the `/subagents` panel and the `/reminders` view —
bordered box with the `Todos (done/total)` summary riding the top border, a
cursor-following windowed list (`↑↓/jk`, pgup/pgdn, home/end), above/below
counters, and a key-hint footer. A 1s signature poll re-renders when the list
changes underneath, so items the agent completes while the panel is open flip
to done live. `esc`/`q`/`enter` closes. Non-TUI modes fall back to notifying
the widget lines as text. The popup is display-only — mutations go through
the `todo` tool so they persist in the session branch.

## Completion nudge

Triggered on `agent_settled`. Conditions to fire:
1. At least one todo has status `todo` or `pending`.
2. `activeWaits.size === 0` (see protocol below).

The nudge text lists every incomplete item and instructs the agent to first
verify which are actually finished (toggle done) then continue the rest.
Delivered as `followUp` + a `warning` notify.

**De-duplication:** the hook records a signature (`count|sorted-ids`) of the
incomplete set each time it fires. If `agent_settled` fires again with the
same incomplete signature, the nudge is suppressed — the agent already saw it
and chose to stop, do not spam. Any mutation through the `todo` tool resets
the signature so the next stop nudges freshly, and so does a
`todo:nudge-reset` event (below).

After deciding, todo emits the shared `todo:settled` event exported by
`snapshot.ts`:

| Disposition | Condition |
|-------------|-----------|
| `continue` | a fresh incomplete-list nudge was sent |
| `wait` | `activeWaits.size > 0`, whatever the list looks like — a finished list that is still waiting on a subagent or a reminder is not a finished run |
| `review` | no continuation was scheduled and nothing is being waited on: empty/all-done, or an unchanged incomplete list already nudged |

Workflow extensions consume this event instead of independently reading todo
state or reproducing the nudge and wait rules. This makes todo the single owner
of settle behavior and avoids extension-load-order races.

## Cross-extension active-wait protocol

So the nudge stays silent while the agent is legitimately blocked, todo
listens on the `pi.events` bus for two events:

```
wait:active  { source: string, id: string }
wait:done    { source: string, id: string }
```

`source` identifies the originating extension (`"subagent"`, `"reminder-hook"`,
or any future one). The extension maintains `activeWaits: Set<"${source}:${id}">`
and treats `size > 0` as "something is being waited on — do not nudge, and do
not report the run finished". Workflow extensions that start a review on
`review` therefore stay in the acting phase while a wait is open.

This cannot park a workflow: every wait ends and announces it — a subagent
emits `wait:done` in its exit path and delivers its result as a follow-up, a
reminder fires, is cancelled or times out — and that follow-up produces the
next settled turn, which then reports `review`.

Any extension that represents a wait should emit these:

| Extension | Emits `wait:active` | Emits `wait:done` |
|-----------|---------------------|-------------------|
| reminder-hook | on `set_reminder` arm, and again on `session_start` re-arm | on fire / cancel / timeout |
| subagent | on `dispatch` entry added | on child end / cancel |

`activeWaits` is memory-only, so anything that survives a restart has to
re-announce itself on `session_start` — otherwise the nudge fires during a
perfectly legitimate wait.

Adding a new wait-style extension only requires emitting the same two events —
todo picks it up with no code change.

## Known limitations

- The nudge uses `followUp`, so it really does trigger a new agent turn (token
  cost). This is intentional — the goal is to actually resume work — but watch
  cost on tight budgets.
- De-dup is by incomplete-id signature, not content. If the agent adds then
  removes a todo with no net id change, the signature is unchanged.
- Widget does not accept keyboard input; it is display-only. Editing is via
  the `todo` tool only.
- A wait that never ends blocks `review` for exactly as long as it lasts. That
  is the intent — a run waiting on something is not finished — and it is
  visible and reversible (cancel the reminder, cancel the subagent, or exit the
  workflow), so no watchdog is imposed on top. The one unbounded case is a
  reminder armed with a condition and no `timeout_minutes`: its predicate may
  never become true, and it then holds `wait` indefinitely.

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

agent_settled fires:
  incomplete = todos where status != "done"
  if activeWaits.size > 0:
     → emit todo:settled { disposition: "wait" }
  else if incomplete set is fresh:
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

## Widget

`ctx.ui.setWidget("todo", lines, { placement: "belowEditor" })` whenever the
list changes. Empty list clears the widget (`setWidget("todo", undefined)`); a fully-done
list stays visible so the user can see what was accomplished this round.
`/todos` or the `clear` action empties it.
Each line: `<glyph> #<id> <text>` where glyph is `○` (todo), `◐` (pending),
`✓` (done, dimmed).

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
the signature so the next stop nudges freshly.

After deciding, todo emits the shared `todo:settled` event exported by
`snapshot.ts`:

| Disposition | Condition |
|-------------|-----------|
| `continue` | a fresh incomplete-list nudge was sent |
| `wait` | `activeWaits.size > 0` |
| `review` | no continuation was scheduled: empty/all-done, or an unchanged incomplete list already nudged |

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
and treats `size > 0` as "something is being waited on — do not nudge".

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

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
  if incomplete.length > 0 AND activeWaits.size === 0:
     → pi.sendUserMessage(nudge, { deliverAs: "followUp" })
     → ctx.ui.notify("... — nudging agent", "warning")
  else:
     → silent (nothing to do, or legitimately waiting)
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
`session_tree` scan the current branch's `todo` tool results in order and
reconstruct `todos` / `nextId`, so the list is always correct for the active
branch point.

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
| reminder-hook | on `set_reminder` arm | on fire / cancel / timeout |
| subagent | on `dispatch` entry added | on child end / cancel |

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

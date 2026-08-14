# pi-gated-goal

A wait-aware extension set for [Pi](https://pi.dev), the coding agent harness.
The headline feature is **gated-goal** — a plan → act → review loop with a
frozen, tamper-proof plan and an independent reviewer subagent that gates
completion. The other three extensions are the supporting cast that makes the
loop behave well in a long-running session: subagent delegation, todo tracking,
and park-and-resume reminders.

They ship together because they cooperate at runtime via a small `wait:active` /
`wait:done` event protocol: when a subagent or reminder is in flight, the todo
nudge suppresses itself so the agent isn't pushed to "continue" while it's
correctly waiting. Installing them as a set is the intended usage.

## Requirements

- [Pi](https://pi.dev) (the coding agent). These extensions only depend on
  Pi's own runtime types (`@earendil-works/pi-coding-agent`, `typebox`) — no
  extra npm packages, so installation is instant and conflict-free.

## Install

```bash
pi install git:github.com/garnetlyx/pi-gated-goal
```

Update:

```bash
pi update --extensions          # update all installed packages
pi install git:github.com/garnetlyx/pi-gated-goal@<tag>   # pin / move to a tag
```

Project-local install (scoped to the current directory only):

```bash
pi install -l git:github.com/garnetlyx/pi-gated-goal
```

Pi auto-discovers `extensions/*/index.ts` from the installed package, so all
four extensions load together. Enable/disable individual extensions with
`pi config` — none are auto-enabled, you choose when to activate each.

## What's in the box

| Extension | Tools | Commands | Purpose |
|-----------|-------|----------|---------|
| `gated-goal` | `freeze_plan`, `confirm_done`, `reject_done` | `/gated-goal`, `/gated-goal-exit`, `/gated-goal-status` | Plan-act-review loop with a frozen plan and an independent reviewer that gates completion. |
| `subagent` | `dispatch`, `dispatch_status`, `dispatch_cancel`, `subagent_roles` | `/subagents` | Delegate self-contained work to a child model. The reviewer in gated-goal is itself a subagent. |
| `todo` | `todo` | `/todos` | Visible task list that nudges the agent to verify and continue incomplete work — but stays quiet when a subagent or reminder is active. |
| `reminder-hook` | `set_reminder`, `cancel_reminder` | `/reminders`, `/cancel-reminder` | Park any completable wait (process exit, file appearance, URL health, scheduled time) as a shell predicate; resumes the agent when the condition is met. |

### The wait protocol

`subagent`, `reminder-hook`, and `todo` share a tiny event contract:

```
wait:active  { source: string, id: string }   — something is being waited on
wait:done    { source: string, id: string }   — wait resolved
```

`subagent` emits it for each running child; `reminder-hook` emits it for each
armed reminder; `todo` listens and suppresses its "you have incomplete todos"
nudge while any wait is active. That is why they're a package and not four
independent installs — the cooperation is the point.

## Manual setup

If you prefer not to use `pi install`:

```bash
git clone https://github.com/garnetlyx/pi-gated-goal.git
# global (all projects):
ln -s "$PWD/pi-gated-goal/extensions/gated-goal"   ~/.pi/agent/extensions/gated-goal
ln -s "$PWD/pi-gated-goal/extensions/subagent"     ~/.pi/agent/extensions/subagent
ln -s "$PWD/pi-gated-goal/extensions/todo"         ~/.pi/agent/extensions/todo
ln -s "$PWD/pi-gated-goal/extensions/reminder-hook" ~/.pi/agent/extensions/reminder-hook
```

Pi discovers extensions from `~/.pi/agent/extensions/*/index.ts` (global) or
`.pi/extensions/*/index.ts` (project-local).

## Configuration

`subagent` reads optional role and concurrency configuration from
`~/.pi/agent/subagent.json` (created on first use). See
[`extensions/subagent/SKILL.md`](extensions/subagent/SKILL.md) for the full
schema. The other three extensions have no configuration.

State (frozen plans, reminder lists, subagent registry) is stored under Pi's
agent directory (`~/.pi/agent/`), session-scoped, so it survives `/reload` and
restarts.

## License

MIT — see [LICENSE](LICENSE).

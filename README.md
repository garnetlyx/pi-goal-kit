# pi-agents-goal-workflow

Four cooperating extensions for [Pi](https://pi.dev). The design center is
**gated-goal**: a five-phase loop that freezes the acceptance bar against
tampering, keeps the agent self-driving mid-task, and gates completion behind
an adversarial review. The other three (`reminder-hook`, `todo`, `subagent`)
are useful standalone, and together they form the substrate gated-goal runs on.

Two ideas run through all four:

- **Flexibility — not bound by config, not bound by fixed tools.** No model
  allowlist, no predeclared agent manifest, and no tool-per-scenario: the wait
  condition is a shell predicate the agent writes, the subagent role need not
  exist in any config file. Config supplies defaults; the agent decides at call
  time. The same four extensions cover scenarios they were never written for.
- **Distill what actually drives a task, then defend it.** Pin the requirement,
  nail the acceptance gate shut against tampering (frozen sha256), self-drive
  the middle instead of stalling, and let subagents do double duty —
  **collaboration** for parallel throughput *and* **adversarial QA**, a reviewer
  whose incentive is to find gaps rather than agree.

## Install

```bash
pi install git:github.com/garnetlyx/pi-agents-goal-workflow
```

Update, pin, or install project-local:

```bash
pi update --extensions
pi install git:github.com/garnetlyx/pi-agents-goal-workflow@<tag>
pi install -l git:github.com/garnetlyx/pi-agents-goal-workflow
```

Pi auto-discovers `extensions/*/index.ts`. None are auto-enabled — turn them on
with `pi config`.

## The extensions (simple → complex)

| Extension | What it does | Tools / commands |
|---|---|---|
| [reminder-hook](extensions/reminder-hook/docs/DESIGN.md) | Park any wait, resume on a predicate | `set_reminder`, `cancel_reminder` / `/reminders`, `/cancel-reminder` |
| [todo](extensions/todo/docs/DESIGN.md) | Task list with a wait-aware completion nudge | `todo` / `/todos` |
| [subagent](extensions/subagent/docs/DESIGN.md) | Non-blocking delegation, no allowlist | `dispatch`, `dispatch_status`, `dispatch_cancel`, `subagent_roles` / `/subagents` |
| [gated-goal](extensions/gated-goal/docs/DESIGN.md) | Five-phase loop behind a frozen plan | `freeze_plan`, `confirm_done`, `reject_done` / `/gated-goal`, `/gated-goal-exit`, `/gated-goal-status` |

**reminder-hook** — the agent writes the completion condition as a shell
command (exit 0 = done), optionally gated by a time or countdown, plus a resume
prompt for itself. When the predicate passes, the prompt is injected back as a
follow-up. Process exit, file appearance, URL health, a log line, a CI/CD run
turning green, a download finishing, a cron-style schedule — every one of them
is `bash -c` plus an exit code, so one generic tool covers them all instead of
a new canned tool per wait type. The conversation never blocks.

**todo** — a persistent below-editor widget plus an `agent_settled` hook: if
the agent stops with incomplete todos *and nothing else is being waited on*, a
follow-up nudges it to continue. A naive nudge fires on every stop, including
correct ones ("the build is running"), which teaches the agent to ignore it.
This one stays silent while any wait is active.

**subagent** — delegates a self-contained task to a model in a separate `pi`
subprocess with its own context, tool whitelist, and timeout. User config
(`~/.pi/agent/subagent.json`) holds reusable role *suggestions*, not a gate:
mid-session the agent can improvise a role or model that appears in no config
file (the task calls for it, or today's suggested model is down), and always
states `model`, `permissions`, and `timeout` explicitly per call — the
extension never silently picks one. Most multi-agent setups make you predeclare
every agent in YAML and redeploy to add one. The same stack serves both
**collaboration** (parallel delegation) and **adversarial QA** (gated-goal's
read-only reviewer).

**gated-goal** — started by `/gated-goal [maxIteration] [reviewerModel]`.
`freeze_plan` captures outcome, verification, constraints, and quality bars,
then hashes and persists them, so the agent cannot quietly relax its own
success criteria mid-task. Completion then needs two independent passes:

```
idle ──/gated-goal [N] [model]──► P1 select reviewer
                                   │ ping "reply ok" (45s timeout)
                                   ├─ fail ─► abort to idle (no state saved)
                                   ▼
                                 P2 plan
                                   │ agent + user align on goal
                                   │ agent calls freeze_plan(outcome, verification,
                                   │   constraints, quality, todos)
                                   │ → frozen prompt hashed + persisted
                                   │ → todos created (via followUp instruction)
                                   ▼
                                 P3 act  ◄──────────────────┐
                                   │ agent works the todos    │
                                   │ on agent_settled:        │
                                   │   all todos done?        │
                                   │     ├─ no  → stay P3     │
                                   │     │   (todo ext nudges)│
                                   │     └─ yes → P4          │
                                   ▼                          │
                                 P4 review                    │
                                   │ spawn reviewer subagent  │
                                   │   (frozen prompt + hash) │
                                   │ parse output:            │
                                   │   <promise>DONE</promise>│
                                   │     ├─ yes → P5          │
                                   │     │                    │
                                   │     └─ no  → edits ──────┤
                                   │              reviewsCompleted++
                                   │              >= maxIter? ─► exit: max iteration reached
                                   ▼                          │
                                 P5 verify                    │
                                   │ main agent re-runs       │
                                   │   frozen verification    │
                                   │   itself, judges output  │
                                   │   subjectively           │
                                   │   ├─ confirm_done ─► exit: done
                                   │   └─ reject_done ────────┘
                                   │      reviewsCompleted++
                                   │      >= maxIter? ─► exit: max iteration reached
                                   (loop back to P3 ACT)
```

P4's reviewer is read-only and cannot edit the work; P5 makes the main agent
re-run the frozen verification itself. The second gate exists because
end-to-end testing caught a reviewer rubber-stamping work that provably failed
its own frozen verification. Iteration is symmetric — "reviewer not satisfied"
and "main agent rejected a rubber-stamp" cost the same. Full transition rules,
hash integrity, and iteration accounting:
[`gated-goal/docs/DESIGN.md`](extensions/gated-goal/docs/DESIGN.md).

## How they cooperate

`subagent`, `reminder-hook`, and `todo` share one event contract:

```
wait:active  { source: string, id: string }   — something is being waited on
wait:done    { source: string, id: string }   — wait resolved
```

`subagent` emits per running child, `reminder-hook` per armed reminder, and
`todo` suppresses its nudge while any wait is active. `gated-goal` runs its
reviewer on the subagent stack, so the reviewer shows up in `/subagents`, emits
the same events, and inherits `PI_SUBAGENT_CHILD=1` (no sub-subagents). Split
the bundle and both the wait-aware nudge and the adversarial review break.

## Manual setup

```bash
git clone https://github.com/garnetlyx/pi-agents-goal-workflow.git
for e in gated-goal subagent todo reminder-hook; do
  ln -s "$PWD/pi-agents-goal-workflow/extensions/$e" ~/.pi/agent/extensions/$e
done
```

## Requirements

[Pi](https://pi.dev). Depends only on Pi's own runtime types
(`@earendil-works/pi-coding-agent`, `typebox`) — no extra npm packages.

## License

MIT — see [LICENSE](LICENSE).

# pi-agents-goal-workflow

A bundle of four cooperating extensions for [Pi](https://pi.dev), the coding
agent. The design center is **gated-goal** — a five-phase state machine that
pins down requirements, freezes an acceptance gate against tampering, keeps
the agent self-driving mid-task, and uses subagents both for parallel work and
for adversarial review. The other three extensions (reminder-hook, todo,
subagent) are each useful on their own, but together they form the substrate
that makes the gated-goal loop behave well.

## Design philosophy

Two convictions shape this bundle.

**1. Flexibility over configuration lock-in.** Agent workflows drift the
moment the session gets interesting: a new kind of wait appears, a different
model is better for one subtask, an unplanned review is needed. These
extensions refuse to hardcode those decisions. There is no fixed tool list,
no allowlist that silently chooses a model for you, no manifest that decides
in advance what an agent may delegate. Everything that narrows behavior is a
*suggestion* the main agent can override at call time — user config provides
defaults, the session provides availability, and the agent decides from
context. The cost of this is a slightly more demanding agent; the payoff is
that the same four extensions cover any future scenario without growing new
tool types.

**2. Distill the essence of task-driven work, then defend it.** Every
non-trivial task reduces to four things: a clear outcome, a verifiable
acceptance bar, self-driven progress between start and finish, and an
independent check that the bar was actually met (not rubber-stamped). Most
"agent loop" products do the first two loosely and skip the last two. This
bundle makes all four first-class:

- **Pin the requirement.** `freeze_plan` captures outcome + verification +
  constraints + quality bars, hashes the result, and persists the hash. The
  plan is immutable from that point — edits are detected, never silently
  honored.
- **Nail the acceptance gate shut.** A frozen sha256 means the agent cannot
  quietly relax its own success criteria mid-task to declare victory.
- **Self-drive the middle.** `todo` nudges the agent to finish what it
  started; `reminder-hook` lets it park any wait without busy-polling. The
  agent keeps moving on its own.
- **Adversarial review, not self-certification.** A separate subagent (the
  reviewer) runs the frozen verification with read-only tools and cannot edit
  the work. The main agent then re-verifies the reviewer's claim itself, so a
  rubber-stamping reviewer is caught. Subagents here do double duty:
  **collaboration** (parallel delegation for productivity) *and* **adversarial
  QA** (an independent reviewer whose incentive is to find gaps, not to
  agree).

## Install

```bash
pi install git:github.com/garnetlyx/pi-agents-goal-workflow
```

Update / pin / project-local:

```bash
pi update --extensions
pi install git:github.com/garnetlyx/pi-agents-goal-workflow@<tag>
pi install -l git:github.com/garnetlyx/pi-agents-goal-workflow
```

Pi auto-discovers `extensions/*/index.ts`. Enable/disable individual
extensions with `pi config` — none are auto-enabled.

## The extensions (simple → complex)

### reminder-hook — park any wait, resume on a predicate

The agent describes an arbitrary completion condition as a shell command
(exit 0 = done), optionally gated by an absolute time or a countdown, and
leaves a resume prompt for itself. When the predicate is satisfied, the
extension injects that prompt back as a follow-up and posts a system
notification. The conversation is never blocked.

**Why this shape:** every "wait for X" — process exit, file appearance, URL
health, a log line, market open, a CI/CD run turning green, a download
finishing, a cron-style schedule — reduces to `bash -c` with an exit code.
Letting the agent write the predicate covers all of them without the
extension growing a new tool per scenario. Competing approaches either block
the conversation (sleep/busy-poll) or ship one canned tool per wait type.
This one ships one generic tool and gets cron, CI/CD polling, download
waits, and health checks for free.

Tools: `set_reminder`, `cancel_reminder`. Commands: `/reminders`,
`/cancel-reminder`.

### todo — a task list that nudges, but not blindly

A `todo` tool with a persistent below-editor widget. The interesting part is
the `agent_settled` hook: if the agent stops with incomplete todos *and
nothing else is being waited on*, a follow-up nudges it to verify and
continue. If a subagent or reminder is active, the nudge stays silent.

**Why the state-awareness matters:** a naive todo-nudge fires on every stop,
including stops that are correct ("the build is running", "the reviewer is
reading"). That teaches the agent to ignore the nudge. This bundle's todo
listens to a shared `wait:active` / `wait:done` event bus — the same protocol
subagent and reminder-hook emit on — so it only nudges when the agent is
*actually* idle with unfinished work. It catches the common local-model
failure of stopping mid-task without nagging through legitimate waits.

Tool: `todo`. Command: `/todos`.

### subagent — delegation without an allowlist

Non-blocking orchestration: the main agent delegates a self-contained task to
a model running in a separate `pi` subprocess with its own context, tool
whitelist, and timeout. Completion returns as an unverified follow-up.

**Why both config *and* ad-hoc:** user config (`~/.pi/agent/subagent.json`)
holds reusable role suggestions — model hints, default permissions, optional
system prompts. But those are *advice*, not a gate. The main agent can, in
the same session, `dispatch` a subagent for a role or model that isn't in any
config file — because the task at hand calls for it, or a suggested model is
unavailable today. The extension never silently picks a model; the agent
always states `model`, `permissions`, `timeout` explicitly per call. Most
multi-agent setups force you to predeclare every agent in YAML and re-deploy
to add one; here the main agent improvises within the session.

Tools: `dispatch`, `dispatch_status`, `dispatch_cancel`, `subagent_roles`.
Command: `/subagents`.

### gated-goal — the design center

A five-phase state machine that gates task completion behind **two**
independent checks: an adversarial reviewer subagent *and* a main-agent
verification pass, both measured against a frozen, hashed plan. Started by
`/gated-goal [maxIteration] [reviewerModel]`.

**Why five phases and two gates:** the first version had four
(plan → act → review → done) and trusted the reviewer's `<promise>DONE</promise>`.
End-to-end testing exposed the hole — a reviewer can rubber-stamp, approving
work that provably failed its own frozen verification. The dedicated VERIFY
phase makes the main agent re-run the verification itself and subjectively
judge the real output before closing the loop. The frozen hash stops the
agent from relaxing its acceptance bar mid-task; the double gate stops a
compliant reviewer from declaring victory.

This is where the bundle's philosophy pays off: flexibility (the agent picks
the reviewer model per task, freezes its own concrete plan, can reject and
rework) combined with a defended essence (immutable acceptance gate,
adversarial review, symmetric iteration budget so both "reviewer not
satisfied" and "main agent rejected rubber-stamp" cost the same).

Tools: `freeze_plan`, `confirm_done`, `reject_done`. Commands: `/gated-goal`,
`/gated-goal-exit`, `/gated-goal-status`.

#### State machine

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

Two exit-success paths converge at `confirm_done`. Three abort paths:
reviewer never satisfied within budget, main agent rejects within budget, or
manual `/gated-goal-exit`. See
[`extensions/gated-goal/docs/DESIGN.md`](extensions/gated-goal/docs/DESIGN.md)
for the full transition rules, hash integrity, and iteration accounting.

## How they cooperate

`subagent`, `reminder-hook`, and `todo` share a tiny event contract:

```
wait:active  { source: string, id: string }   — something is being waited on
wait:done    { source: string, id: string }   — wait resolved
```

`subagent` emits it per running child; `reminder-hook` per armed reminder;
`todo` listens and suppresses its nudge while any wait is active. `gated-goal`
reuses the subagent stack for its reviewer (so the reviewer appears in
`/subagents`, emits the same wait events, and inherits `PI_SUBAGENT_CHILD=1`
so it cannot spawn sub-subagents). That cooperation is why they ship as a
bundle — split them and the wait-aware nudge and the adversarial review both
break.

## Manual setup

```bash
git clone https://github.com/garnetlyx/pi-agents-goal-workflow.git
# global:
ln -s "$PWD/pi-agents-goal-workflow/extensions/gated-goal"    ~/.pi/agent/extensions/gated-goal
ln -s "$PWD/pi-agents-goal-workflow/extensions/subagent"      ~/.pi/agent/extensions/subagent
ln -s "$PWD/pi-agents-goal-workflow/extensions/todo"          ~/.pi/agent/extensions/todo
ln -s "$PWD/pi-agents-goal-workflow/extensions/reminder-hook" ~/.pi/agent/extensions/reminder-hook
```

## Requirements

[Pi](https://pi.dev). These extensions depend only on Pi's own runtime types
(`@earendil-works/pi-coding-agent`, `typebox`) — no extra npm packages, so
installation is instant and conflict-free.

## License

MIT — see [LICENSE](LICENSE).

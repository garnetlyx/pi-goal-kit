# pi-goal-kit

**Goal-gated workflow for [Pi](https://pi.dev)** — four cooperating extensions.
The design center is **gated-goal**: a five-phase loop that pins the acceptance
bar out of the agent's reach, keeps it self-driving mid-task, and gates
completion behind an adversarial review. The other three (`reminder-hook`,
`todo`, `subagent`) are useful standalone, and together they form the substrate
gated-goal runs on.

Two ideas run through all four:

- **Flexibility — not bound by config, not bound by fixed tools.** No model
  allowlist, no predeclared agent manifest, and no tool-per-scenario: the wait
  condition is a shell predicate the agent writes, the subagent role need not
  exist in any config file. Config supplies defaults; the agent decides at call
  time. The same four extensions cover scenarios they were never written for.
- **Distill what actually drives a task, then defend it.** Pin the requirement
  outside the conversation so it can't be quietly relaxed, hash it (sha256) so
  drift is detectable, self-drive the middle instead of stalling, and let
  subagents do double duty —
  **collaboration** for parallel throughput *and* **adversarial QA**, a reviewer
  whose incentive is to find gaps rather than agree.

## Install

```bash
pi install git:github.com/garnetlyx/pi-goal-kit
```

Update, pin, or install project-local:

```bash
pi update --extensions
pi install git:github.com/garnetlyx/pi-goal-kit@<tag>
pi install -l git:github.com/garnetlyx/pi-goal-kit
```

Pi auto-discovers `extensions/*/index.ts` and enables them by default after
install. Use `pi config` to disable any you don't want.

> [!IMPORTANT]
> Reliable reminder, subagent, and todo continuation through manual compaction
> requires a Pi host that queues explicit extension follow-ups during
> compaction. Otherwise, do not run `/compact` while waits are active.

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
(`subagent.json` in Pi's agent directory) holds reusable role *suggestions*, not a gate:
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
                                   │   (+ archived as a session entry)
                                   │ → todo list REPLACED with the frozen
                                   │   items (todo:replace event)
                                   ▼
                                 P3 act  ◄───────────────────┐
                                   │ agent works the todos   │
                                   │ todo owns settled state:│
                                   │  nudge/wait → stay P3   │
                                   │  no continuation → P4   │
                                   ▼                         │
                                 P4 review                   │
                                   │ spawn reviewer subagent │
                                   │   (frozen prompt + hash)│
                                   │ reviewsCompleted++ on   │
                                   │   EITHER verdict — a    │
                                   │   review that ran is    │
                                   │   a spent iteration     │
                                   │ line starting with
                                   │ <promise>DONE</promise>?
                                   │     ├─ no → >= maxIter? ─► exit: max
                                   │     │        else edits ─┤  iteration
                                   │     └─ yes → P5 (always) │  reached
                                   ▼                         │
                                 P5 verify                   │
                                   │ main agent re-runs the  │
                                   │   frozen verification   │
                                   │   itself, judges output │
                                   │   subjectively          │
                                   │   ├─ confirm_done ─► exit: done
                                   │   └─ reject_done ───────┘
                                   │      (no extra charge — P4
                                   │       already spent this one;
                                   │       if the budget is gone,
                                   │       exits: max iteration reached)
```

P4's reviewer gets no write or edit tools and starts without the project's
`AGENTS.md`/`CLAUDE.md`, so the code under review cannot rewrite the standard
it is reviewed against; P5 makes the main agent re-run the frozen verification
itself. The second gate exists because end-to-end testing
caught a reviewer rubber-stamping work that provably failed its own frozen
verification. Iteration is symmetric — the counter is charged when a review
completes, whatever its verdict, so "reviewer not satisfied" and "reviewer said
DONE, main agent rejected it" cost the same. Full transition rules, hash
integrity, and iteration accounting:
[`gated-goal/docs/DESIGN.md`](extensions/gated-goal/docs/DESIGN.md).

One caveat worth stating plainly: the reviewer's tool whitelist includes
`bash`, which is not sandboxed. Withholding write/edit tools plus an explicit
instruction is a strong default, not an enforced boundary.

## How they cooperate

`subagent`, `reminder-hook`, `todo`, and `gated-goal` share event contracts:

```
wait:active  { source: string, id: string }   — something is being waited on
wait:done    { source: string, id: string }   — wait resolved
todo:settled { disposition, ctx }             — continue | wait | review
```

`subagent` emits per running child and `reminder-hook` per armed reminder.
`todo` alone combines list, nudge de-duplication, and active waits into the
settle disposition; gated-goal consumes it instead of duplicating todo logic.
Gated-goal runs its reviewer on the subagent stack, so the reviewer shows up in
`/subagents`, emits the same wait events, and inherits `PI_SUBAGENT_CHILD=1`
(no sub-subagents). Split the bundle and both the wait-aware nudge and the
adversarial review break.

## Manual setup

If you prefer to manage the checkout yourself (or are contributing), clone it
and link each extension into Pi's agent directory:

```bash
git clone https://github.com/garnetlyx/pi-goal-kit.git
CLONE_DIR="$PWD/pi-goal-kit"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/extensions"
for e in gated-goal subagent todo reminder-hook; do
  ln -s "$CLONE_DIR/extensions/$e" "$AGENT_DIR/extensions/$e"
done
```

All four resolve their own config and state under that same agent directory, so
they follow whatever `pi` itself is using.

## Requirements

[Pi](https://pi.dev) **0.84.1 or later**. Depends only on Pi's own runtime
types (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`) — no extra npm packages. Consumers do not
need to install these; `pi` resolves them at load time.

## License

MIT — see [LICENSE](LICENSE).

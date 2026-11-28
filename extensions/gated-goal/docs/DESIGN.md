# Gated-goal

A six-phase workflow that gates task completion behind an independent reviewer
subagent AND a main-agent verification pass, both checking work against a
frozen, hashed plan — and gates the freezing of that plan itself behind the
same reviewer, which audits it against the conversation with the user. Started
by `/gated-goal [maxIteration] [reviewerModel]`.

The double gate exists because a reviewer subagent can rubber-stamp (approve
without actually running verification). The main agent's own verification pass
is the final arbiter. The freeze loop (P2.5) exists because a plan that
misreads the user's intent gets executed, reviewed and verified flawlessly —
against the wrong goal; the only point where that can be caught is before the
plan becomes immutable, with the user still in the conversation.

## Why six phases

The first version had four (plan → act → review → done) and trusted the
reviewer's `<promise>DONE</promise>`. End-to-end testing exposed the hole: a
local reviewer model emitted DONE without running the verification command,
approving work that provably failed the frozen verification. The VERIFY phase
makes the main agent re-run the verification itself and subjectively judge the
real output before closing the loop.

The freeze loop was added for the same reason one step earlier: the frozen
plan is the standard everything downstream is checked against, so a plan that
adds work the user never asked for, drops what they did, or silently decides
an open question makes every later phase correct about the wrong thing. The
reviewer reads the session transcript and either approves the plan or sends
the agent back to the user with concrete questions.

## State machine

An interactive version of this diagram lives in
[`state-machine.html`](./state-machine.html) — open it in a browser to drive the
phases yourself and watch `state.json`, the iteration budget and the exit paths
move together.

```
idle ──/gated-goal [N] [model]──► P1 select reviewer
                                   │ ping "reply ok" (config: pingTimeoutSec)
                                   ├─ fail ─► abort to idle (nothing left active)
                                   ▼
                                 P2 plan  ◄──────────────────┐
                                   │ agent + user align on   │
                                   │   goal; agent calls     │
                                   │   freeze_plan(outcome,  │
                                   │   verification,         │
                                   │   constraints, quality, │
                                   │   todos)                │
                                   ▼                         │
                                 P2.5 freeze                 │
                                   │ reviewer reads the      │
                                   │   session transcript    │
                                   │   and audits the plan:  │
                                   │   intent match? open    │
                                   │   ambiguities?          │
                                   │ freezeRejections >=     │
                                   │   maxIter → skip to P3  │
                                   │ a line that is exactly  │
                                   │ <promise>DONE</promise>?│
                                   │   ├─ no (verdict) ──────┘
                                   │   │    back to P2 with the
                                   │   │    reasons; counter++
                                   │   ├─ no verdict (timeout/
                                   │   │   crash) → P2, not counted
                                   │   └─ yes → frozen prompt hashed
                                   │       + persisted (+ archived
                                   │       as a session entry)
                                   │       → todo list REPLACED with
                                   │       the frozen items
                                   │       (todo:replace event)
                                   ▼
                                 P3 act  ◄───────────────────┐
                                   │ agent works the todos   │
                                   │ todo owns settled state:│
                                   │  nudge/wait → stay P3   │
                                   │  (a wait outranks a     │
                                   │   finished list)        │
                                   │  no continuation → P4   │
                                   ▼                         │
                                 P4 review                   │
                                   │ spawn reviewer subagent │
                                   │   (frozen prompt + hash)│
                                   │ reviewsCompleted++ on   │
                                   │   EITHER verdict — a    │
                                   │   review that returned  │
                                   │   one is a spent        │
                                   │   iteration; timeout/   │
                                   │   crash charges nothing │
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

Two exit-success paths converge at `confirm_done`. Three abort paths:
reviewer never satisfied within budget, main agent rejects within budget, or
manual `/gated-goal-exit`.

## Files

| Path | Purpose |
|------|---------|
| `extensions/gated-goal/index.ts` | `/gated-goal`, `/gated-goal-exit`, `/gated-goal-status` commands; `freeze_plan`, `confirm_done`, `reject_done` tools; consumes todo's P3→P4 settle disposition; `extractSection` helper |
| `extensions/gated-goal/plan-review.ts` | The P2.5 step: `renderTranscript`, `writeTranscript`, `buildIntentReviewPrompt`, `runIntentReview` (transcript → reviewer → transcript deleted; abort signal, staleness, never throws) and the `freeze_plan` tool with its budget and transitions (`registerFreezePlanTool` over the `FreezeGate` interface) |
| `extensions/gated-goal/reviewer.ts` | reviewer prompts (`buildReviewerSystemPrompt`, `deadlineNotice`), the shared child spawn `spawnReviewer`, `pingReviewer` (P1), `runReview` (P4), verdict parsing (`isApproved`, `isStandaloneApproval`), `cancelActiveReviewer` |
| `extensions/gated-goal/state.ts` | load/save the session state file; phase types (`idle|plan|freeze|act|review|verify`); frozen-prompt hashing; integrity check |
| `extensions/gated-goal/SKILL.md` | agent-facing phase guide |

## Persisted state (`<agent dir>/gated-goal/sessions/<sessionId>/state.json`)

`<agent dir>` is Pi's agent directory, resolved via `getAgentDir()` — never
hardcoded, since it differs between a stock install and a bundled one.

```json
{
  "phase": "idle | plan | freeze | act | review | verify",
  "maxIteration": 10,
  "reviewsCompleted": 0,
  "freezeRejections": 0,
  "reviewerModel": "provider/modelId",
  "reviewerPermissions": ["read", "grep", "find", "ls", "bash"],
  "frozenPrompt": "## Outcome\n...\n## Verification\n...\n## Constraints\n...\n## Code Quality Requirements\n...",
  "frozenHash": "<sha256 of frozenPrompt>",
  "startedAt": 1785300000000,
  "originalCwd": "/path/to/project/when/the/run/started",
  "transcriptDir": "/os/tmp/pi-subagent-XXXX (only while a P2.5 review runs)"
}
```

- `phase` drives every transition; todo's settle event, `agent_settled` in VERIFY, and the tools branch on it.
- `freezeRejections` counts consecutive P2.5 rejections of the plan; the cap is
  `maxIteration` (same value, separate counter, never charged to
  `reviewsCompleted`); reset when a plan is frozen.
- `reviewsCompleted` increments once per completed review, on either verdict, so
  both kinds of "this iteration didn't close the loop" consume budget
  symmetrically. See [Iteration accounting](#iteration-accounting).
- `frozenPrompt` is the canonical four-section plan; `frozenHash` is its sha256.
- `reviewerPermissions` is fixed at `["read","grep","find","ls","bash"]` — the
  reviewer gets no write/edit tools and is instructed to use bash for
  inspection only (tests, build, `git diff`). Note that bash is not sandboxed,
  so this is an instruction rather than an enforced boundary. Being a subagent,
  it also inherits `PI_SUBAGENT_CHILD=1` and cannot dispatch sub-subagents.

- `originalCwd` is captured on first save. If a later session loads the state
  from a different `ctx.cwd` (project moved or mounted elsewhere) while a run
  is active, the extension warns that file paths in the frozen plan may need
  reinterpretation — the plan itself stays valid.

`load()` merges persisted state over a safe `EMPTY` default so missing fields
never crash. `save()` writes atomically enough for this use (single writer).
Exiting sets `phase: "idle"` and records `exitReason` rather than deleting the
file, so the last run stays inspectable. `exitReason` is terminal: `reload()`
collapses any live phase found next to it back to idle (self-heal for state
files written by the pre-epoch bug described below).

### Epoch latch (exit vs in-flight review)

A review cycle is fire-and-forget: `runReviewCycle` spawns the reviewer and
its continuation acts on the result when `await runReview` resolves — which
can be minutes later. Every authoritative transition bumps `gateEpoch`:
`teardownGate` (the one teardown path, shared by `exitGate` and the start-over
branch of `/gated-goal`), `reload()` (session switch, incoming instance) and
the outgoing instance's `session_shutdown` handler (session switch, `/reload`)
bump it. A cycle — or a freeze call, which captures the epoch the same way
— re-checks it after every await; a mismatch means the result belongs to a
gate that no longer exists, and the continuation discards it — no phase
write, no follow-up message. Without the latch, a reviewer that crashed
*after* the user exited would write `phase: "act"` back over idle and inject
"Back to ACT" into an exited session, resurrecting the loop (observed in the
wild as `phase: act` + `exitReason` set in the same state file;
regression-tested in `test/gated-goal-exit.test.ts`). `teardownGate` also
kills the in-flight reviewer child (`cancelActiveReviewer`) so an abandoned
review does not run to its timeout in the background, and persists
`phase: "idle"` at once — a start-over whose ping then fails (or pi crashes
mid-ping) cannot come back as a live gate.

A start-over tears the old gate down the moment the user confirms "Abort and
start over?", not once the replacement reviewer has passed its ping: the abort
is what was confirmed, and a gate whose reviewer is already killed and whose
continuation is discarded must not linger in `review` with nothing left that
can move it. If the old gate already finished while the confirmation was open,
its terminal reason is preserved until a new run starts. Start-over skips only the exit announcement — success supersedes it
immediately, and the extra follow-up would cost an agent turn.

### Restart recovery

A state file found in `review` on `session_start` belongs to a process that is
gone (pi restarted): the reviewer's continuation died with it, so no verdict
can ever land here and nothing was charged (see
[Iteration accounting](#iteration-accounting)). The handler flips to `act`,
persists, and sends a follow-up naming the lost review (`reviewsCompleted + 1`)
so the agent re-presents completion; todo's next `review` disposition then
starts a fresh cycle. It deliberately does not re-spawn the reviewer itself —
opening a session must not launch a review process on its own.

A state file found in `freeze` is the same situation one step earlier: the
intent review died with the process, so nothing was decided and nothing was
charged. The handler removes the transcript the crash left behind
(`transcriptDir`), flips to `plan` (the counter is kept) and sends a
follow-up telling the agent to call `freeze_plan` again so the review re-runs.

## Plan freeze loop (P2.5)

The plan is the standard every later phase is checked against, so the gate
checks the plan itself before it becomes immutable. `freeze_plan` does not
freeze; it submits. `plan-review.ts` owns the step end to end and drives the
state machine through a small `FreezeGate` interface (live state, epoch,
save, status, ACT entry); `index.ts` only provides that interface.

**What is reviewed.** The proposal = the four canonical sections **plus the
todos** that will be installed in ACT (a contradictory todo would otherwise
become active without appearing in full in the review input). The evidence =
the session's current branch, rendered by `renderTranscript` to a 0600 file in
the OS temp dir: user and assistant prose in full, one line per tool call,
tool results truncated, thinking and bookkeeping entries omitted. The session
stores extension follow-ups exactly like human input, so the prompt describes
them generically — workflow messages the gate injects, typically opening with
an emoji marker, are the gate talking to the agent, not the user's intent. The
reviewer (`runPlanReview`, same model, window, permissions and isolation as a
work review) judges exactly two things: intent match (nothing material added,
dropped or weakened; no todo contradicting the sections) and ambiguity
(choices silently made, two-plausible-readings terms, conflicting statements,
a confirmation taken before the user had seen what they were confirming).

**Verdict protocol.** Stricter than P4's: approval is a line consisting of
exactly `<promise>DONE</promise>`, outside code fences (`isStandaloneApproval`;
an unclosed fence counts as code through the end). A tag sharing its line
with anything else — a summary, "is an example", a negation — is a mention.
Otherwise the reviewer outputs `Intent mismatches:` and `Questions to ask the
user:`.

**Outcomes and transitions.**

- *Approved* → `freezeRejections = 0`, then the freeze itself: canonical
  prompt hashed and stored, `phase: "act"`, archived as a `gated-goal-frozen`
  session entry, `todo:replace` with the frozen items, follow-up to the agent.
- *Rejected* → `phase: "plan"`, `freezeRejections = K`, warning notify, and an
  isError result carrying the reviewer's text plus the instruction to discuss
  each point with the user before calling again. When K reaches M the result
  also states that the **next** call skips the review.
- *No verdict* (child timed out, crashed, was cancelled) or the review could
  not run at all (transcript I/O, spawn, config) → `phase: "plan"`, nothing
  counted, isError telling the agent to inform the user before retrying. The
  gate is never left in `freeze`.
- *Budget exhausted* (`freezeRejections >= maxIteration` at the next call) →
  the transition to ACT and the counter reset are persisted first, then the
  user is told the review was skipped. See [Freeze budget](#freeze-budget-p25).

Nothing forces a user turn between a rejection and the next call: the intent
reviewer is told to reject again when the transcript shows the user has not
addressed the earlier issues, and the cap bounds the ping-pong.

**Cancellation.** The freeze call can lose the gate in three ways and checks
for each: (1) `/gated-goal-exit`, start-over or a restart bumps the epoch —
checked before the transcript is written, before the spawn and after the
review, so a lost gate never spawns a reviewer, writes state or announces
anything; (2) the tool call's abort signal (the user cancelled the turn) is
passed through to the child spawn and prevents a spawn if already aborted —
the review then counts as no verdict; (3) a session switch emits
`session_shutdown` on the **outgoing** extension instance, whose continuations
(the P4 review cycle, a freeze call) hold that instance's closures: the
handler bumps its epoch and kills its reviewer child, because the incoming
instance's `session_start` cannot reach them. The same handler covers
`/reload`.

**Transcript lifecycle.** Written just before the spawn, removed in a
`finally` whatever the outcome, never announced. Its dir is persisted as
`transcriptDir` while it exists so that a crash — which skips the `finally` —
leaves nothing behind: the restart recovery removes it.


## Commands

| Command | Effect |
|---------|--------|
| `/gated-goal [maxIteration] [reviewerModel]` | Start. If already active, asks to abort+restart; confirming tears the old gate down at once (persisted idle, reviewer killed), so a failed ping leaves nothing active. Resolves reviewer model (arg → searchable picker → esc=main), pings it, enters P2. |
| `/gated-goal-exit` | Manual abort. Exits with reason "aborted by user". |
| `/gated-goal-status` | Notify current phase / iteration / reviewer; in `plan` and `freeze` also `freeze-rejections=K/M`. |

### Arg parsing

Tokens are split on whitespace. The first all-numeric token (if any) becomes
`maxIteration` (clamped ≥ 1). Everything else is joined into the reviewer
model string. If no numeric token, `maxIteration` defaults to 10. This is
order-tolerant: `/gated-goal 2`, `/gated-goal claude-sonnet-4-5`, and
`/gated-goal 2 claude-sonnet-4-5` all work.

### Model resolution

1. Explicit arg → use it.
2. Else `availableModels(ctx)` non-empty → searchable model picker
   (`subagent/model-picker.ts`): type to filter by partial provider/id/name,
   ↑↓/jk move, pgup/pgdn/home/end jump. The built-in `ctx.ui.select` is not
   used here — it renders every option with no viewport or filtering, so long
   catalogues overflow the terminal and off-screen models become unreachable.
   Non-TUI modes (rpc/json/print) fall back to `ui.select`.
   - `availableModels` prefers `ctx.scopedModels` (session-scoped catalogue),
     falls back to enumerating `ctx.modelRegistry`.
3. Else (or picker cancelled/esc) → main agent's current model
   (`${ctx.model.provider}/${ctx.model.id}`).

### Connectivity ping (`pingReviewer`)

A reviewer probe with the task "reply with exactly: ok" and a minimal
read-only system prompt. The window comes from user config
(`gatedGoal.pingTimeoutSec` in `<agent dir>/subagent.json`, default 45s). It
adds a throwaway registry entry (so it shows in
`/subagents` and emits `wait:active/done`), then:

- child status ≠ `done` → throw `${status}: ${errorMessage}`
- final output lacks `ok` (case-insensitive) → throw "returned no 'ok'"

Any throw bubbles to the command handler, which shows an error notify and
aborts. A fresh start has written nothing; a start-over has already torn the
previous gate down at confirm time (see [Epoch latch](#epoch-latch-exit-vs-in-flight-review)),
so either way no gate is left active. Cold local models that need more than the
configured window to first token will falsely fail — raise
`gatedGoal.pingTimeoutSec` in `subagent.json` if that bites you.

## Tools

### `freeze_plan` (P2 → P2.5 → P3)

Parameters: `outcome`, `verification`, `constraints`, `quality` (all strings),
plus `todos` (non-empty array of `{text, status?}` with non-blank text). Only
valid while `phase === "plan"` (so a second call while a freeze review is in
flight is refused); an empty array or any blank todo is rejected before state
changes. Everything else it does is the [Plan freeze loop](#plan-freeze-loop-p25).

### `confirm_done` (P5 → exit done)

Parameter: optional `note`.

The final gate. Valid only while `phase === "verify"`. Calls `exitGate(ctx,
"done" + note)` → clears status, notifies, followUps a "🚪 exited — done"
message.

### `reject_done` (P5 → P3)

Parameter: required `reason`.

Valid only while `phase === "verify"`. Flips to `phase === "act"` and followUps
the reason back as feedback ("you rejected the reviewer's DONE as a
rubber-stamp ... apply the fix, then stop").

It does **not** touch `reviewsCompleted`: reaching VERIFY already charged the
iteration in P4, so incrementing here would double-count. It **does** enforce
the cap: if the charged iteration was the last one, `reject_done` exits with
"max iteration reached" instead of returning to ACT. This is the only place the
cap can end an approved review, because P4 always lets a DONE verdict through
to VERIFY.

### VERIFY anti-stall

Neither tool flipped the phase and the agent still settled → it ended its turn
without deciding. `agent_settled` while `phase === "verify"` sends a follow-up
demanding an explicit `confirm_done` or `reject_done`: without a manual abort
or restart, only these decisions move the gate out of VERIFY, so a model that merely reports its verification result and
stops would park the loop there for good.

## Reviewer (`reviewer.ts`)

`runReview` and `pingReviewer` reuse the subagent stack (`scheduler.ts`
registry + `runner.ts` `runChild`), and the plan intent review goes through
the same shared spawn (`spawnReviewer`, exported for `plan-review.ts`); the two
reviews differ only in prompt and task. Each reviewer:

- is added to the registry → appears in `/subagents` with role `"reviewer"`
  (`reviewer-N` for work reviews, `plan-reviewer-N` for intent reviews)
- emits `wait:active` on registry add, `wait:done` in a `finally` → the todo
  extension's nudge stays silent while a review runs
- is cancellable: `cancelActiveReviewer()` (same mechanics as
  `dispatch_cancel`) kills the in-flight child; `teardownGate` (exit and
  `/gated-goal` start-over) calls it so a dead gate does not keep a doomed
  review running
- spawns with `PI_SUBAGENT_CHILD=1` (set by `runChild`) → **cannot dispatch**
- uses `reviewerPermissions` = read/grep/find/ls/bash
- runs with `--no-context-files` (`contextFiles: false` → `runChild`), so the
  reviewed project's own `AGENTS.md` / `CLAUDE.md` cannot rewrite the review
  standard. Those files load regardless of project trust, so trust settings are
  not a substitute. Ordinary `dispatch` still inherits them by default. The
  bundle's `general-principles` injector honours the same flag (verified with a
  real child process: with `--no-context-files` no AGENTS.md reaches the
  reviewer's context), otherwise the flag would only look like isolation.
- runs under a hard timeout from user config — `gatedGoal.reviewTimeoutSec`
  in `<agent dir>/subagent.json` (default 1800s), enforced by `runChild`
  (SIGTERM→SIGKILL). On timeout it is treated as a crash: `runReviewCycle`
  catches, flips back to `act`, notifies. No exit on timeout, no iteration
  charge — a killed review is not a verdict (see Iteration accounting).

**The review window is user-config-only, deliberately out of the main agent's
reach.** The main agent is the party under review; a party that can set its
own review window can bias the verdict — starving the reviewer into a
truncated non-verdict, or stretching the window to grind out an approval.
Like the frozen plan, review process parameters must live outside the
reviewed party's control surface, so `runReview` reads the value from
`loadConfig(ctx)` and no tool or parameter exposes it to the main agent.

The review system prompt embeds the frozen prompt verbatim and dictates the
output contract:
- **start a line** with `<promise>DONE</promise>`, followed by a one-line
  summary, **only if fully satisfied**;
- otherwise list concrete required changes, and do not write the tag at all.

It also carries a **time budget** block, because a killed review is never a
verdict: the prompt states the configured window and the absolute hard-kill
deadline (spawn time + timeout, as a UTC timestamp plus unix seconds), tells
the reviewer to plan first (output what it will verify and in what order, then
execute step by step), and — since mid-run message injection is impossible
(the child is a one-shot `pi -p` process with stdin ignored) — instructs it to
self-check the clock with `date +%s` between steps and, once fewer than 300
seconds remain, stop verifying and write its final verdict immediately: a
timely verdict with fewer checks beats a truncated one.

`isApproved()` implements that contract: fenced code blocks are dropped, then
the tag must open a line (whitespace-tolerant inside the tag). A bare substring
test used to read "do not output `<promise>DONE</promise>` until the tests
pass", or a fenced example, as approval — and silently dropped the required
changes with it. On top of that, only a child that exited cleanly
(`status === "done"`) can approve; a timed-out or crashed review is never a
verdict, however its truncated output happens to end.

## Hash integrity

`verifiedFrozenPrompt(ctx, state)` recomputes sha256 of `state.frozenPrompt` at
every `runReview`:

- match → use the stored prompt, `tampered: false`.
- mismatch → look for the `gated-goal-frozen` session entry written by
  `freeze_plan`, take the newest one that still hashes to its own recorded
  hash, and review **that** (`tampered: true, restored: true`).
- mismatch with no intact archive → use the stored prompt as-is
  (`restored: false`). Both cases surface as a note on the P4 feedback.

**Mismatch never exits the gate.** Exiting on mismatch would let anyone abort
the workflow by editing a file. Recovery is what the archive buys: the state
file under the agent dir is no longer the only copy, and the two live in
different stores.

What this does *not* do: stop a determined edit. Anything that can write the
state file can rewrite `frozenHash` alongside `frozenPrompt`, and a
synchronized rewrite is self-consistent by construction. The check catches an
inconsistent pair — corruption, a partial edit, a stale copy — not an
adversary.

## Transition rule (P3 → P4)

`freeze_plan` requires at least one non-blank todo, so PLAN cannot enter ACT
without an initial work list. After that, todo remains a work-control surface,
not completion evidence: the agent may finish by marking every item done or by
clearing the list, and reviewer feedback may add a fresh list for another ACT
round.

Todo is the sole owner of `agent_settled`, incomplete-list de-duplication, and
active-wait semantics. It emits the shared `todo:settled` contract exported by
`extensions/todo/snapshot.ts`:

| Disposition | Meaning | Gated-goal action |
|-------------|---------|-------------------|
| `continue` | Todo sent one fresh incomplete-list follow-up | stay in ACT |
| `wait` | A subagent, reminder, or other external wait is active | stay in ACT |
| `review` | Todo scheduled no continuation | enter REVIEW |

`review` therefore covers an empty list, an all-done list, and an unchanged
incomplete list that already received its one nudge. Gated-goal does not read
todo snapshots or reproduce those conditions; it listens for the disposition
and calls `runReviewCycle(ctx)` only for `review` while `phase === "act"` and a
frozen hash exists. This keeps the settle decision in one module and avoids
handler-order races between independent `agent_settled` subscribers.

Every return to ACT on the gate's own instruction — reviewer feedback,
`reject_done`, a lost verdict (timeout, crash, cancellation), restart recovery
— goes through `enterAct`, which also emits `todo:nudge-reset`: a new iteration
is a new nudge boundary. The incomplete set is unchanged, so without the
re-arm todo's de-duplication reads the next stop as "already nudged" and
reports `review` at once; the list would be looked at exactly once per gate.
The feedback messages name the list for the same reason ("reconcile your todo
list with this feedback"). One re-arm buys one nudge; the stop after that is
`review` again, so an agent that keeps ignoring the list still reaches the
reviewer — and the iteration budget — instead of looping.

## Iteration accounting

`reviewsCompleted` is charged in exactly one place: when a review finishes
with a verdict — **either** verdict. A review that returned a verdict is a
spent iteration regardless of what it concluded, so "reviewer not satisfied"
and "reviewer said DONE, main agent then rejected it" cost the same. A review
that timed out, crashed, or was cancelled produced no verdict (only a cleanly
finished child can approve, and a truncated changes-list is not a conclusion
either), so it charges nothing and returns to ACT for a re-run.
`reject_done` deliberately adds nothing on top.

The cap is checked after the increment on the **rejection** path only: a
reviewer that asks for changes with no budget left exits "max iteration
reached". An approving review always proceeds to VERIFY, however many
iterations are left — otherwise the last allowed review could never finish the
goal, and `maxIteration = 1` would make success unreachable outright. If VERIFY
then rejects that approval and the budget is gone, `reject_done` exits with the
same reason.

`maxIteration = N` therefore permits up to N reviews, each of which can reach
VERIFY.

### Freeze budget (P2.5)

`freezeRejections` is charged in exactly one place: a finished intent review
that did not approve. A timed-out, crashed or cancelled intent reviewer, or a
review that could not run at all, charges nothing — the same rule as for work
reviews. Once `freezeRejections` reaches `maxIteration`, the next `freeze_plan`
call skips the review and freezes as proposed. The two counters never touch:
plan rejections are not review iterations, and a frozen plan resets them to 0.

## Cross-extension cooperation

Gated-goal composes the three earlier extensions:

- **todo** — owns the todo list plus all `agent_settled`, nudge de-duplication,
  and active-wait decisions. Gated-goal consumes todo's exported
  `todo:settled` disposition and never duplicates those rules; its only write
  into todo is the `todo:nudge-reset` event at every return to ACT (see
  Transition rule). The reviewer's `wait:active` keeps todo in `wait` while P4
  is running.
- **subagent** — reviewer is a subagent. Reuses `genId`, `registry`, `splitModel`,
  `runChild`, and the follow-up sink (`follow-up.ts`, below). Shows in
  `/subagents`.
- **reminder-hook** — not used directly, but the `wait:active/wait:done` protocol
  it established is what makes the todo nudge stay quiet during reviews.

## Follow-up delivery across compaction

Every message the gate sends — phase announcements, verdicts, feedback, the
exit line — goes through `createFollowUpSink`
(`extensions/subagent/follow-up.ts`). A verdict lands from an async continuation
that cannot know whether the user is mid-`/compact`; pi rejects a prompt
submitted during a manual compaction ("Cannot submit a prompt while compaction
is in progress") and, since `pi.sendUserMessage` returns `void` and core
reports the rejection itself, the extension never learned of it. The message
was lost after the state write: a charged iteration (`reviewsCompleted`,
`phase: act`) whose feedback the agent never received, or a gate parked in
VERIFY with nothing to say.

The sink holds such messages from `session_before_compact` until the
compaction's end event — flushed one macrotask later, because pi emits
`session_compact` before clearing its prompt guard (earendil-works/pi#9647) —
and drops everything on `session_shutdown`. The three verdict continuations
pass `isStale: () => gateEpoch !== myEpoch`, so a verdict held through a
compaction during which the gate exited is discarded instead of resurrecting
it: the epoch latch's rule, applied at delivery time and not only before the
send. The reminder-hook and subagent extensions deliver their wake-ups and
completions through the same sink for the same reason.

Removal condition: pi queues extension follow-ups during compaction instead of
rejecting them (upstream #9647). The sink then collapses to a plain
`pi.sendUserMessage(text, { deliverAs: "followUp" })`.

## Footer status

`setStatus("gated-goal", …)` shows `gated-goal[phase] reviews/max` while
active, plus a hint. Event-driven hints: `planning`, `acting`, `reviewing`,
`verifying`, `iteration N`. The freeze hints are derived from persisted state
every time the status is painted — `intent review K/M` in `freeze`,
`freeze rejected K/M` in `plan` with rejections — so they survive the
`agent_settled` refresh that lands exactly when the user reads the agent's
questions, and a resume. Cleared on exit. Refreshed on `session_start` and
`agent_settled`.

## Known limitations / trade-offs

- **Rubber-stamp is mitigated, not impossible.** VERIFY adds an independent
  check, but the main agent's judgment is itself subjective and can also be
  wrong. The bar (`confirm_done` vs `reject_done`) is deliberately subjective —
  there is no automated pass/fail of command output. If you want hard
  pass/fail, encode it in the verification section and a future extension could
  parse it.
- **Wrap-up compliance is advisory, not enforced.** The time budget in the
  reviewer prompt relies on the model actually running `date +%s` and
  stopping in time. A reviewer that ignores it is still bounded by the hard
  kill — it just risks a truncated non-verdict (which charges nothing, so the
  cost is wall-clock, not budget).
- **`availableModels` is best-effort.** If both scopedModels and registry
  enumeration fail, the picker is skipped and the main model is used silently.
- **`freeze_plan` requires and replaces todos atomically** — an empty array or
  blank item is rejected before state changes, and `todo:replace` persists the
  validated non-empty list before ACT work begins.
- **State file is not concurrency-locked.** Single-agent assumption; fine for
  the intended interactive use.
- **VERIFY is subjective by design.** The acceptance criterion for the
  reverse-check is "main agent's subjective judgment", not a parsed
  verification result. This is intentional for now — it raises the bar over
  trusting the reviewer without requiring a formal verifier.
- **The intent review sees a rendered transcript, not the raw session.** User
  and assistant prose is complete, tool traffic is compacted, and gate
  follow-ups (which the session stores exactly like human input) can only be
  described to the reviewer in the prompt, not marked in the data. Its verdict
  is a model judgment; a reviewer that approves an ambiguous plan is caught
  only by the user, who is in the conversation anyway.
- **A crash leaves the reviewer's prompt temp file behind.** When pi is killed
  (SIGHUP) mid-review, no `finally` runs: the transcript is removed on the
  next start (via `transcriptDir`), but the runner's `pi-subagent-*/prompt-*.md`
  for the killed child is not tracked anywhere and stays in the OS temp dir.

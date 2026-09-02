# Gated-goal

A five-phase workflow that gates task completion behind an independent reviewer
subagent AND a main-agent verification pass, both checking work against a
frozen, hashed plan. Started by `/gated-goal [maxIteration] [reviewerModel]`.

The double gate exists because a reviewer subagent can rubber-stamp (approve
without actually running verification). The main agent's own verification pass
is the final arbiter.

## Why five phases

The first version had four (plan → act → review → done) and trusted the
reviewer's `<promise>DONE</promise>`. End-to-end testing exposed the hole: a
local reviewer model emitted DONE without running the verification command,
approving work that provably failed the frozen verification. The VERIFY phase
makes the main agent re-run the verification itself and subjectively judge the
real output before closing the loop.

## State machine

An interactive version of this diagram lives in
[`state-machine.html`](./state-machine.html) — open it in a browser to drive the
phases yourself and watch `state.json`, the iteration budget and the exit paths
move together.

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

Two exit-success paths converge at `confirm_done`. Three abort paths:
reviewer never satisfied within budget, main agent rejects within budget, or
manual `/gated-goal-exit`.

## Files

| Path | Purpose |
|------|---------|
| `extensions/gated-goal/index.ts` | `/gated-goal`, `/gated-goal-exit`, `/gated-goal-status` commands; `freeze_plan`, `confirm_done`, `reject_done` tools; consumes todo's P3→P4 settle disposition; `extractSection` helper |
| `extensions/gated-goal/reviewer.ts` | `pingReviewer` (P1 connectivity probe) + `runReview` (P4 spawn with hash verify + promise parse) |
| `extensions/gated-goal/state.ts` | load/save the session state file; phase types (`idle|plan|act|review|verify`); frozen-prompt hashing; integrity check |
| `extensions/gated-goal/SKILL.md` | agent-facing phase guide |

## Persisted state (`<agent dir>/gated-goal/sessions/<sessionId>/state.json`)

`<agent dir>` is Pi's agent directory, resolved via `getAgentDir()` — never
hardcoded, since it differs between a stock install and a bundled one.

```json
{
  "phase": "idle | plan | act | review | verify",
  "maxIteration": 10,
  "reviewsCompleted": 0,
  "reviewerModel": "provider/modelId",
  "reviewerPermissions": ["read", "grep", "find", "ls", "bash"],
  "frozenPrompt": "## Outcome\n...\n## Verification\n...\n## Constraints\n...\n## Code Quality Requirements\n...",
  "frozenHash": "<sha256 of frozenPrompt>",
  "startedAt": 1785300000000,
  "originalCwd": "/path/to/project/when/the/run/started"
}
```

- `phase` drives every transition; todo's settle event, `agent_settled` in VERIFY, and the tools branch on it.
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
file, so the last run stays inspectable.

## Commands

| Command | Effect |
|---------|--------|
| `/gated-goal [maxIteration] [reviewerModel]` | Start. If already active, asks to abort+restart. Resolves reviewer model (arg → searchable picker → esc=main), pings it, enters P2. |
| `/gated-goal-exit` | Manual abort. Exits with reason "aborted by user". |
| `/gated-goal-status` | Notify current phase / iteration / reviewer. |

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

A 45s reviewer probe with the task "reply with exactly: ok" and a minimal
read-only system prompt. Adds a throwaway registry entry (so it shows in
`/subagents` and emits `wait:active/done`), then:

- child status ≠ `done` → throw `${status}: ${errorMessage}`
- final output lacks `ok` (case-insensitive) → throw "returned no 'ok'"

Any throw bubbles to the command handler, which shows an error notify and
aborts without writing state. Cold local models that need >45s to first token
will falsely fail — raise the timeout in `pingReviewer` if that bites you.

## Tools

### `freeze_plan` (P2 → P3)

Parameters: `outcome`, `verification`, `constraints`, `quality` (all strings),
plus `todos` (non-empty array of `{text, status?}` with non-blank text).

- Builds the canonical frozen prompt via `buildFrozenPrompt` (four `## Section`
  blocks, deterministic order, what `extractSection` later parses).
- Hashes it (`hashPrompt`, sha256), stores both in state.
- Flips `phase` to `act`, persists.
- Archives `{prompt, hash}` as a `gated-goal-frozen` session entry
  (`pi.appendEntry`) — a second store the integrity check can recover from.
- Rejects an empty array or any blank todo before changing state.
- Emits `todo:replace` with the frozen items, which **replaces** the todo list
  wholesale (see `extensions/todo/snapshot.ts`). Asking the model to add them
  instead appended to whatever it had already written down during PLAN, so a
  freeze routinely doubled the work list.
- Sends a followUp confirming the list and telling the agent to start acting
  without re-adding anything.

Only valid while `phase === "plan"`. Elsewhere returns isError.

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

## Reviewer (`reviewer.ts`)

`runReview` and `pingReviewer` both reuse the subagent stack
(`scheduler.ts` registry + `runner.ts` `runChild`). Each reviewer:

- is added to the registry → appears in `/subagents` with role `"reviewer"`
- emits `wait:active` on registry add, `wait:done` in a `finally` → the todo
  extension's nudge stays silent while a review runs
- spawns with `PI_SUBAGENT_CHILD=1` (set by `runChild`) → **cannot dispatch**
- uses `reviewerPermissions` = read/grep/find/ls/bash
- runs with `--no-context-files` (`contextFiles: false` → `runChild`), so the
  reviewed project's own `AGENTS.md` / `CLAUDE.md` cannot rewrite the review
  standard. Those files load regardless of project trust, so trust settings are
  not a substitute. Ordinary `dispatch` still inherits them by default.
- has a 1200s hard timeout (`runChild` SIGTERM→SIGKILL); on timeout it is
  treated as a crash: `runReviewCycle` catches, flips back to `act`, notifies.
  No exit on timeout.

The review system prompt embeds the frozen prompt verbatim and dictates the
output contract:
- **start a line** with `<promise>DONE</promise>`, followed by a one-line
  summary, **only if fully satisfied**;
- otherwise list concrete required changes, and do not write the tag at all.

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

## Iteration accounting

`reviewsCompleted` is charged in exactly one place: when a review finishes, for
**either** verdict. A review that ran is a spent iteration regardless of what it
concluded, so "reviewer not satisfied" and "reviewer said DONE, main agent then
rejected it" cost the same. `reject_done` deliberately adds nothing on top.

The cap is checked after the increment on the **rejection** path only: a
reviewer that asks for changes with no budget left exits "max iteration
reached". An approving review always proceeds to VERIFY, however many
iterations are left — otherwise the last allowed review could never finish the
goal, and `maxIteration = 1` would make success unreachable outright. If VERIFY
then rejects that approval and the budget is gone, `reject_done` exits with the
same reason.

`maxIteration = N` therefore permits up to N reviews, each of which can reach
VERIFY.

## Cross-extension cooperation

Gated-goal composes the three earlier extensions:

- **todo** — owns the todo list plus all `agent_settled`, nudge de-duplication,
  and active-wait decisions. Gated-goal consumes todo's exported
  `todo:settled` disposition and never duplicates those rules. The reviewer's
  `wait:active` keeps todo in `wait` while P4 is running.
- **subagent** — reviewer is a subagent. Reuses `genId`, `registry`, `splitModel`,
  and `runChild`. Shows in `/subagents`.
- **reminder-hook** — not used directly, but the `wait:active/wait:done` protocol
  it established is what makes the todo nudge stay quiet during reviews.

## Footer status

`setStatus("gated-goal", …)` shows `gated-goal[phase] reviews/max` while
active, plus a phase hint (`acting`, `reviewing`, `verifying`,
`iteration N`). Cleared on exit. Refreshed on `session_start` and
`agent_settled`.

## Known limitations / trade-offs

- **Rubber-stamp is mitigated, not impossible.** VERIFY adds an independent
  check, but the main agent's judgment is itself subjective and can also be
  wrong. The bar (`confirm_done` vs `reject_done`) is deliberately subjective —
  there is no automated pass/fail of command output. If you want hard
  pass/fail, encode it in the verification section and a future extension could
  parse it.
- **Reviewer ping timeout is fixed at 45s.** Very cold local models may need
  more.
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

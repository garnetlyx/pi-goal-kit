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
manual `/gated-goal-exit`.

## Files

| Path | Purpose |
|------|---------|
| `extensions/gated-goal/index.ts` | `/gated-goal`, `/gated-goal-exit`, `/gated-goal-status` commands; `freeze_plan`, `confirm_done`, `reject_done` tools; `agent_settled` P3→P4 transition; `extractSection` helper |
| `extensions/gated-goal/reviewer.ts` | `pingReviewer` (P1 connectivity probe) + `runReview` (P4 spawn with hash verify + promise parse) |
| `extensions/gated-goal/state.ts` | load/save `state/agent/gated-goal.json`; phase types (`idle|plan|act|review|verify`); frozen-prompt hashing; integrity check |
| `skills/gated-goal/SKILL.md` | agent-facing phase guide |

## Persisted state (`state/agent/gated-goal.json`)

```json
{
  "phase": "idle | plan | act | review | verify",
  "maxIteration": 10,
  "reviewsCompleted": 0,
  "reviewerModel": "provider/modelId",
  "reviewerPermissions": ["read", "grep", "find", "ls", "bash"],
  "frozenPrompt": "## Outcome\n...\n## Verification\n...\n## Constraints\n...\n## Code Quality Requirements\n...",
  "frozenHash": "<sha256 of frozenPrompt>",
  "startedAt": 1785300000000
}
```

- `phase` drives every transition; `agent_settled` and the tools all branch on it.
- `reviewsCompleted` increments on every non-DONE review AND every `reject_done`.
  So both kinds of "this iteration didn't close the loop" consume budget
  symmetrically. `maxIteration` caps both.
- `frozenPrompt` is the canonical four-section plan; `frozenHash` is its sha256.
- `reviewerPermissions` is fixed at `["read","grep","find","ls","bash"]` —
  reviewer can run tests/git but cannot edit. It is a subagent, so it also
  inherits `PI_SUBAGENT_CHILD=1` and cannot dispatch sub-subagents.

`load()` merges persisted state over a safe `EMPTY` default so missing fields
never crash. `save()` writes atomically enough for this use (single writer).
`clear()` removes the file on exit.

## Commands

| Command | Effect |
|---------|--------|
| `/gated-goal [maxIteration] [reviewerModel]` | Start. If already active, asks to abort+restart. Resolves reviewer model (arg → ui.select → esc=main), pings it, enters P2. |
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
2. Else `availableModels(ctx)` non-empty → `ctx.ui.select` picker (120s timeout).
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
plus `todos` (array of `{text, status?}`).

- Builds the canonical frozen prompt via `buildFrozenPrompt` (four `## Section`
  blocks, deterministic order, what `extractSection` later parses).
- Hashes it (`hashPrompt`, sha256), stores both in state.
- Flips `phase` to `act`, persists.
- Sends a followUp telling the agent to create the todos via the todo tool and
  start acting.

Only valid while `phase === "plan"`. Elsewhere returns isError.

### `confirm_done` (P5 → exit done)

Parameter: optional `note`.

The final gate. Valid only while `phase === "verify"`. Calls `exitGate(ctx,
"done" + note)` → clears status, notifies, followUps a "🚪 exited — done"
message.

### `reject_done` (P5 → P3)

Parameter: required `reason`.

Valid only while `phase === "verify"`. Increments `reviewsCompleted`; if that
hits `maxIteration` → `exitGate("max iteration reached")`. Else flips to
`phase === "act"` and followUps the reason back as feedback ("you rejected the
reviewer's DONE as a rubber-stamp ... apply the fix, then stop").

## Reviewer (`reviewer.ts`)

`runReview` and `pingReviewer` both reuse the subagent stack
(`scheduler.ts` registry + `runner.ts` `runChild`). Each reviewer:

- is added to the registry → appears in `/subagents` with preset `"reviewer"`
- emits `wait:active` on registry add, `wait:done` in a `finally` → the todo
  extension's nudge stays silent while a review runs
- spawns with `PI_SUBAGENT_CHILD=1` (set by `runChild`) → **cannot dispatch**
- uses `reviewerPermissions` = read/grep/find/ls/bash
- has a 1200s hard timeout (`runChild` SIGTERM→SIGKILL); on timeout it is
  treated as a crash: `runReviewCycle` catches, flips back to `act`, notifies.
  No exit on timeout.

The review system prompt embeds the frozen prompt verbatim and dictates the
output contract:
- output `<promise>DONE</promise>` + a one-line summary **only if fully
  satisfied**;
- otherwise list concrete required changes, no promise tag.

Promise detection is whitespace-tolerant: `/<promise>\s*DONE\s*<\/promise>/i`.

## Hash integrity

`verifiedFrozenPrompt(state)` recomputes sha256 of `state.frozenPrompt` at
every `runReview`:

- match → use the stored prompt, `tampered: false`.
- mismatch → still use the stored prompt, but flag `tampered: true`. The flag
  surfaces in the P4 feedback note ("frozen prompt integrity check flagged —
  archived version used").

**Mismatch never exits the gate.** Exiting on mismatch would let an attacker
tamper with the prompt to abort the workflow. There is no "separate original"
to restore from — the persisted `(prompt, hash)` pair is the source of truth,
and the hash is the authoritative one. The flag is purely informational.

## Transition rule (P3 → P4)

The `agent_settled` handler checks, while `phase === "act"`:

```
if frozenHash is set AND all todos done:
    runReviewCycle(ctx)   // → P4
else:
    // stay in act; the todo extension nudges on incomplete todos
```

`allTodosDone(ctx)` scans the current session branch for the latest `todo`
tool result and checks every item is `done`. If there are no todos at all it
returns false — you cannot review what was never planned.

This single rule covers both the first P3 pass and re-entry after review
feedback: if the main agent doesn't reopen todos, they stay all-done, so the
next stop re-triggers P4 automatically. Symmetry with P5→P3 (`reject_done`)
keeps the loop spinning without special-casing.

## Iteration accounting

Both "reviewer not satisfied" and "main agent rejected rubber-stamp" increment
`reviewsCompleted`. Before each return-to-P3, `reviewsCompleted >= maxIteration`
→ exit "max iteration reached". So `maxIteration = N` permits up to N total
non-closing iterations across both kinds.

## Cross-extension cooperation

Gated-goal composes the three earlier extensions:

- **todo** — owns the todo list and the `agent_settled` nudge. Gated-goal reads
  todos via session-branch scan (not a direct import) and relies on the nudge
  to keep P3 alive. The reviewer's `wait:active` keeps the nudge silent during
  P4/P5.
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
- **`freeze_plan` creates todos indirectly** — via a followUp instructing the
  agent to call the `todo` tool, because the todo extension owns its session
  entry schema. A misbehaving agent could skip this; P3 won't proceed without
  todos, so it would just stall in act (recoverable via user nudge).
- **State file is not concurrency-locked.** Single-agent assumption; fine for
  the intended interactive use.
- **VERIFY is subjective by design.** The acceptance criterion for the
  reverse-check is "main agent's subjective judgment", not a parsed
  verification result. This is intentional for now — it raises the bar over
  trusting the reviewer without requiring a formal verifier.

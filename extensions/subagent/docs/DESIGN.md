# Subagent

Non-blocking orchestration: the main agent delegates a self-contained task to
a model running in a separate `pi` subprocess with its own context and tool
whitelist. Completion is injected as a follow-up and marked unverified.

## Authority and configuration model

The main agent is always the dispatcher. Every `dispatch` call explicitly
chooses `model`, `permissions`, and `timeout` using the current user request,
task, session model catalogue, user suggestions, and operational constraints.
The extension never silently chooses a model.

There are three deliberately non-overlapping sources:

| Source | Sole responsibility |
|---|---|
| Pi session model registry (`models.json` plus registered providers) | factual model availability |
| `subagent.json` | single user-owned source: model policy (suggestions + blacklist), role suggestions, resource/concurrency configuration, and optional role system prompts |
| `extensions/subagent/SKILL.md` | main-agent decision policy and tool usage |

`subagent.json` is resolved through Pi's agent directory, not `ctx.cwd`, so
the same preferences apply no matter which project Pi is started from.

Role `models.suggested` are ordered advice, not an allowlist or fallback
algorithm. Suggestions may be bare model IDs (match any available provider) or
fully-qualified `provider/modelId`. The main agent may ignore an available
suggestion when the current task or user request warrants it. If none are
available, it chooses another suitable model from the current session. The
global `models.suggested` list is the fallback when a role gives none.

Blacklist: `models.blacklist` is a hard fence around the **agent's**
autonomous dispatch — not around human choices. Patterns are matched
case-insensitively as substrings against `provider/id` and the display name,
so `gpt` blocks `gpt-5.6-sol`, `gpt-6-astra`, and any provider carrying such
IDs; a provider fragment blocks a whole provider. The `dispatch` tool refuses
blocked models with an error that names the matched pattern and lists allowed
models, and `subagent_roles` hides them from the catalogue, hint resolution,
and the preferred pick (reporting how many were hidden). Surfaces where a
human explicitly picks — the gated-goal reviewer model picker, and the
reviewer spawn path itself, which bypasses `dispatch` — use the unfiltered
catalogue by construction. The main session's own model is never affected.
Empty or missing `suggested`/`blacklist` mean no constraint; entries are
treated as plain strings, never as allowlist or regex.

A `/subagent <model> <prompt>` pick is the third human-pick surface. It
completes against every connected model (`modelRegistry.getAvailable()`,
the list `/model` offers), blacklisted models included, and grants a one-time override bound to exactly the picked
`provider/modelId`; `dispatch` consumes that override on the next dispatch of
that model and refuses every other blacklisted model as before.

Role prompts: a role's `systemPrompt` field in `subagent.json` is a *suggested*
prompt, not a forced injection. The main agent may pass it through, edit it,
replace it, or supply an ad-hoc one via `dispatch`'s `systemPrompt` parameter.
When no prompt is set, a generic default (working principles + structured
output template) is used.

## Runtime flow

```text
main agent optionally calls subagent_roles
main agent calls dispatch { task, timeout, permissions, model, role? }
        |
        v
extension validates explicit model against current session catalogue
extension resolves resource group and optional role work prompt
extension acquires semaphore and spawns:
  pi --mode json -p --no-session --model <m> --tools <whitelist>
     --append-system-prompt <role-prompt>  (PI_SUBAGENT_CHILD=1)
        |
        | JSON messages/results stream into registry
        | registry mutations push renders to /subagents
        | watchdog flags inactivity; hard timeout kills child
        v
pi.sendUserMessage(result, { deliverAs: "followUp" })
```

Completion uses Pi's session-level follow-up queue. During compaction, the
host must queue explicit extension follow-ups and resume them afterward.

`PI_SUBAGENT_CHILD=1` makes the extension a no-op in children, preventing
nested dispatch.

Each dispatch emits at most one `wait:done`. Queue waits are cancellable and
time-bounded. Session shutdown cancels queued, running, and hung entries.
Cancellation escalates from SIGTERM to SIGKILL after the grace period.

## One registry per process, not per module

`scheduler.ts` stores the registry under
`Symbol.for("pi-goal-kit.subagent.registry.v1")` on `globalThis`, so subagent
and gated-goal share one process-wide registry.

## Files

| Path | Purpose |
|---|---|
| `extensions/subagent/index.ts` | tools, watchdog, child guard, default system prompt |
| `extensions/subagent/command.ts` | `/subagent` command: model completion, argument parsing, request hand-over |
| `extensions/subagent/override.ts` | one-time blacklist override for a human-picked model |
| `extensions/subagent/scheduler.ts` | live registry, subscriptions, semaphores |
| `extensions/subagent/runner.ts` | child spawn, JSON capture, timeout, tool gate, context-file gate |
| `extensions/subagent/panel.ts` | bordered `/subagents` overlay |
| `extensions/subagent/config.ts` | `subagent.json` loader/seeder |
| `subagent.json` | single user-owned subagent configuration (roles + optional prompts) |
| `extensions/subagent/SKILL.md` | agent-facing dispatch policy; no concrete model list |

## Tools

### `subagent_roles`

Returns configured roles, ordered suggestions, matches currently available in
the session, and advisory permission/timeout preferences. It explicitly tells
the main agent to adapt rather than treat them as constraints.

With optional `role`, returns the full system prompt that would be injected by
default for that single role (plus its source: `user` if the role sets
`systemPrompt` in `subagent.json`, otherwise the `default` generic prompt), so
the main agent can decide whether to pass it through, edit it, or replace it
via `dispatch`'s `systemPrompt` parameter.

### `dispatch`

Required explicit parameters:

- `task`: detailed self-contained brief;
- `timeout`: per-phase timeout seconds — queue acquisition may consume up to
  this amount, then a started child gets a fresh execution budget of the same
  length (worst-case wall time `2 × timeout`);
- `permissions`: `readonly`, `junior`, `full`, or explicit tool names;
- `model`: currently available `provider/modelId`.

Optional `role` chooses a role description and consults user preferences. Optional
`name` labels the dispatch. Optional `systemPrompt` overrides the role's
default system prompt; by default the role's `systemPrompt` (if set in
`subagent.json`) or the generic default is injected, but the main agent may
pass a modified version, a replacement, or an ad-hoc prompt. The role's
default can be inspected via `subagent_roles` with the `role` parameter. This
keeps the system prompt under the main agent's explicit control, consistent
with how model/permissions/timeout are handled — role prompts are advisory
defaults, not forced injection.

If an explicit model is absent from the current session catalogue, dispatch
fails with usable role suggestions (or available alternatives), requiring the
main agent to choose and retry. It does not auto-substitute.

A role's `timeoutSec` is advisory; the explicit dispatch `timeout` wins. The
same value independently bounds queue acquisition and child execution.
`resourceGroup` routes the provider to its semaphore.

### `dispatch_status` / `dispatch_cancel`

Text status list / cancellation by id.

## User configuration

```json
{
  "defaults": {
    "timeoutSec": 600,
    "hungThresholdSec": 120,
    "defaultResourceGroup": "default",
    "retainCompletedSec": 1800,
    "maxCapturedMessages": 1000
  },
  "resourceGroups": {
    "default": { "concurrency": 4 },
    "local-gpu": { "concurrency": 1 }
  },
  "providerGroups": {
    "some-local-provider": "local-gpu"
  },
  "models": {
    "suggested": ["provider/global-preferred"],
    "blacklist": ["gpt"]
  },
  "roles": {
    "explorer": {
      "description": "Fast reconnaissance",
      "models": { "suggested": ["fast-model", "provider/backup-model"] },
      "permissions": "readonly",
      "timeoutSec": 900,
      "systemPrompt": "optional; replaces the generic default for this role"
    }
  }
}
```

`subagent.json` is seeded only when absent and is re-read per tool call.
Concurrency changes apply to new dispatches; reducing a limit does not stop
active children. `maxCapturedMessages` bounds panel/debug history while final
assistant text is retained separately. Model preferences live in
`models.suggested` (global fallback) and `roles.<name>.models.suggested`
(role binding); `models.blacklist` fences agent dispatch. Configs written in
the pre-rename flat `suggestedModels` role shape are normalized by dropping
that key unread — re-add suggestions under `models.suggested`.

## `/subagents` panel

Bordered opaque focused overlay. `up/down` or `j/k` selects, Enter toggles
output expansion, `a` toggles all/recent, and Escape/q/Ctrl+C closes. Registry
subscriptions push tool results and final output immediately; no idle redraw
loop snaps scrollback.

## `/subagent` command

`/subagent <provider/modelId> <prompt>` — the user names the model, the agent
still dispatches.

- **Completion.** The model argument completes against every connected
  model (`ctx.modelRegistry.getAvailable()`, the list `/model` offers), fuzzy-filtered with the same
  helper the built-in `/model` selector uses (`fuzzyFilter` from
  `@earendil-works/pi-tui`). The item label is the model id, the description
  the provider, and the inserted value the exact `provider/modelId` target
  followed by a space. Only the first argument is completed: once the prompt
  starts, the argument text is the prompt, not a model token. The registry is
  captured at `session_start` (the completion runs outside any handler) and
  refreshed on every invocation; it reads the live catalogue.
- **Resolution.** The first token is the model: `provider/modelId`, or a bare
  model id resolved against the catalogue (ambiguous ids are reported with
  their candidates). The rest of the arguments are the user's prompt,
  verbatim.
- **Hand-over.** The command grants a one-time blacklist override for exactly
  the resolved model and sends the main agent a message naming that model, the
  user's request verbatim, and the instruction to gather the missing context
  itself (the diff under review, the files discussed, ...) and to decide task,
  permissions, timeout, and role. The dispatch decisions stay with the agent.
- **Errors.** A missing model, an unknown model, and an empty prompt are
  reported through `ctx.ui.notify` as errors; nothing is sent to the agent.

## Verification and limitations

All child output is untrusted; the main agent independently checks important
files, commands, and facts.

- Registry and child handles are in memory. `/reload` cancels live children;
  completed history remains process-local and is not durable across restart.
- Tool schemas (including `dispatch` parameters) are registered at session
  start and fixed for the session. `/reload` reloads extension code but does
  **not** refresh the main agent's view of tool schemas — changes to tool
  parameters require a full Pi restart before the main agent can see and fill
  the new fields. Plan extension schema edits as a restart-required change.
- Panel uses fixed list/output line budgets because `render` exposes width but
  not terminal height.
- `readonly` and the reviewer permission set include `bash`, which is not
  sandboxed. They withhold the write/edit *tools*, but a child that ignores
  its instructions can still mutate the workspace via a shell command. Pass an
  explicit whitelist without `bash` when a hard boundary is required.

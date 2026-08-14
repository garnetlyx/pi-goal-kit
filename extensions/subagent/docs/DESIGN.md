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
| `subagent.json` | single user-owned source: role suggestions, resource/concurrency configuration, and optional role system prompts |
| `extensions/subagent/SKILL.md` | main-agent decision policy and tool usage |

`subagent.json` is resolved through Pi's agent directory, not `ctx.cwd`, so
the same preferences apply no matter which project Pi is started from.

Role `suggestedModels` are ordered advice, not an allowlist or fallback
algorithm. Suggestions may be bare model IDs (match any available provider) or
fully-qualified `provider/modelId`. The main agent may ignore an available
suggestion when the current task or user request warrants it. If none are
available, it chooses another suitable model from the current session.

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

`PI_SUBAGENT_CHILD=1` makes the extension a no-op in children, preventing
nested dispatch.

## Files

| Path | Purpose |
|---|---|
| `extensions/subagent/index.ts` | tools, watchdog, child guard, default system prompt |
| `extensions/subagent/scheduler.ts` | live registry, subscriptions, semaphores |
| `extensions/subagent/runner.ts` | child spawn, JSON capture, timeout, tool gate |
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
- `timeout`: hard timeout seconds;
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

A role's `timeoutSec` is advisory only — the explicit dispatch `timeout` always
wins and no warning is emitted on override, because local and quantized models
routinely need far longer than a role's suggested value and nagging would push
the main agent toward under-sizing it. `resourceGroup` is operational
configuration and still routes the chosen provider to the correct semaphore.

### `dispatch_status` / `dispatch_cancel`

Text status list / cancellation by id.

## User configuration

```json
{
  "defaults": {
    "timeoutSec": 600,
    "hungThresholdSec": 120,
    "defaultResourceGroup": "default",
    "retainCompletedSec": 1800
  },
  "resourceGroups": {
    "default": { "concurrency": 4 },
    "local-gpu": { "concurrency": 1 }
  },
  "providerGroups": {
    "some-local-provider": "local-gpu"
  },
  "roles": {
    "explorer": {
      "description": "Fast reconnaissance",
      "suggestedModels": ["fast-model", "provider/backup-model"],
      "permissions": "readonly",
      "timeoutSec": 900,
      "systemPrompt": "optional; replaces the generic default for this role"
    }
  }
}
```

`subagent.json` is seeded with starter roles only when absent, and
never overwritten afterwards. `loadConfig` re-reads it per tool call, but tool
schemas are fixed at session start, so restart Pi when an edit needs to reach
them.

Role prompts carry no model advice, so user model preferences have one source:
`suggestedModels`.

## `/subagents` panel

Bordered opaque focused overlay. `up/down` or `j/k` selects, Enter toggles
output expansion, `a` toggles all/recent, and Escape/q/Ctrl+C closes. Registry
subscriptions push tool results and final output immediately; no idle redraw
loop snaps scrollback.

## Verification and limitations

All child output is untrusted; the main agent independently checks important
files, commands, and facts.

- Registry and child handles are in memory; `/reload` clears history and can
  orphan a currently running child.
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

---
name: subagent
description: "Delegate self-contained work to a subagent by default — exploration, planning, review, implementation, or multimodal reading — unless the task is solvable in a line or a single command. Dispatch is non-blocking, keeps the main context lean, and enables parallel work. Model/permissions/timeout are always main-agent-decided; role preferences are advisory."
---

# Subagent orchestration

A subagent runs in a separate `pi` process with its own context window and tool
whitelist. Dispatch returns immediately; completion wakes the main session.
Subagents cannot dispatch further subagents.

## Decision authority

The **main agent always makes the final dispatch decision**. For every call it
must explicitly choose `model`, `permissions`, and `timeout` based on:

1. an explicit model/role request in the current user turn;
2. the actual task and required capabilities;
3. models available in the current session catalogue;
4. user role suggestions from `subagent.json`;
5. cost, speed, context size, concurrency, and reliability.

Role `suggestedModels` are ordered preferences, not an allowlist, lock, or
automatic fallback. A main agent may choose a different model even when a
suggestion is available. If every suggestion is unavailable or unsuitable,
choose another suitable available model. Never invent an unavailable model.
Use `subagent_roles` when role preferences or current matches are needed.

The session model registry (`models.json` plus any registered providers) is the
source of truth for actual availability. `subagent.json` is the single
user-owned source for role preferences and resource-group configuration. Both
live in Pi's agent directory; `subagent_roles` reports its resolved path. This
skill contains policy, not duplicated model lists.

## `dispatch` — all decisions remain explicit

Required:

- **`task`** — self-contained goal, relevant context, constraints, files or
  scope, and exact expected output. The child does not inherit the conversation.
- **`timeout`** — hard kill in seconds. Typical starting ranges: local or
  quantized models `600–1800`; cloud APIs `60–300`. Adapt to the task/model.
- **`permissions`** — minimum capability required:
  - `"readonly"`: read/grep/find/ls/bash plus safe network tools;
  - `"junior"`: adds write/edit;
  - `"full"`: all tools, only when genuinely required;
  - explicit array such as `["read","grep","web_search"]`.

  `"readonly"` withholds the write/edit tools but still includes `bash`, which
  is not sandboxed — a child that ignores instructions can still change the
  workspace through a shell command. When you need a hard boundary, pass an
  explicit array without `bash`.
- **`model`** — explicit current-session `"provider/modelId"`.

Optional:

- **`role`** — consult a role's user preferences (model hints, permissions,
  timeout, optional systemPrompt). It does not choose the model or permissions.
- **`name`** — display label.

Example:

```text
dispatch({
  role: "explorer",
  task: "Find every call site of loadConfig. Report file:line, purpose, and dependencies as a markdown table. Do not edit files.",
  timeout: 600,
  permissions: "readonly",
  model: "<explicit available provider/modelId>",
  name: "load-config-explorer"
})
```

## Configuration ownership

`subagent.json` contains:

- `roles.<name>.suggestedModels`: ordered bare model IDs or
  `provider/modelId` suggestions;
- role descriptions and advisory permission/timeout preferences;
- `resourceGroups` concurrency limits;
- `providerGroups` mappings;
- retention and hung thresholds.

Bare IDs intentionally survive provider changes; they match any currently
available provider carrying that ID. Fully qualified suggestions target one
provider. The file is read from Pi's agent directory, not the project cwd, so
the same preferences apply no matter which project Pi is started from.

Roles (`explorer`, `planner`, `advisor`, `worker`) live entirely in
`subagent.json` — each carries its own description, model hints,
permissions, timeout, and optional systemPrompt. No bundled prompt files.
A role's fields are advisory; the main agent's explicit dispatch parameters
(model/permissions/timeout/systemPrompt) always win.

The file is created with starter roles on first run and never overwritten
afterwards. It is read per tool call, but tool schemas are fixed at session
start — restart Pi after editing if a change should affect them.

## When to delegate

Dispatch when the task is self-contained, parallelizable, context-heavy, or
benefits from an independent/different model. Do not dispatch a one-step lookup
or work requiring unstated conversation context. Name the real scenario before
adding machinery for hypothetical scale.

## Verification

Subagent output is untrusted. Independently re-read claimed file changes,
re-run important commands, and cross-check factual claims. Another agent or
review is not final authority.

## Monitoring

- `subagent_roles`: show role preferences and currently available suggestion
  matches before choosing.
- `/subagents`: bordered focused overlay; `↑↓`/`j`/`k` navigate, Enter expands,
  `a` toggles all/recent, `esc`/`q`/`Ctrl+C` closes. Registry updates push tool
  results and final output without idle redraws.
- `dispatch_status`: text status list.
- `dispatch_cancel`: cancel by id.
- Hung warnings are advisory; local models can legitimately be quiet.

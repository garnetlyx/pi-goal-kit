---
name: reminder-hook
description: Use whenever you would otherwise block, sleep, or busy-poll while waiting for something to complete — CI/CD pipelines, builds, downloads, deployments, market open, a scheduled time, a URL to become healthy, a log line to appear, a queue to drain, a process to exit, a file to appear, or ANY other completable condition. Schedule a reminder and stop; you are woken automatically. Never blocks the user conversation.
---

# Reminder Hook

When you need to wait for something and would otherwise block, sleep, or
busy-poll, schedule a reminder instead and stop. You'll be woken automatically.

## Non-blocking guarantee

This never blocks the user conversation:
- `set_reminder` returns immediately; the wait happens in the background.
- When the condition is met, your resume `message` is queued with
  `deliverAs: "followUp"` — it triggers a new turn only when the agent is idle.
  If the user is mid-conversation, the reminder waits; it never interrupts.

## The one tool: `set_reminder`

One generic tool covers every scenario. You provide a **completion predicate**
as a shell command (exit 0 = done) and/or a **time gate** (`at` or
`in_minutes`), plus a `message` (the resume prompt you want to receive).

Parameters:
- `message` *(required)* — self-directed resume instruction.
- `condition` *(optional)* — a shell predicate; exit 0 = done. Runs under `bash -c` on macOS/Linux (and on Windows when bash is available via Git Bash/WSL), otherwise under `powershell -NoProfile -Command`. The tool response reports the active shell (`shell bash` / `shell powershell`) — write the predicate in that dialect.
- `at` *(optional)* — `"9:30"`, `"09:30:00"`, or ISO datetime. Time gate.
- `in_minutes` *(optional)* — countdown gate in minutes.
- `poll_seconds` *(optional)* — poll interval (default 30; use larger for long waits).
- `timeout_minutes` *(optional)* — hard cap; fires flagged as timeout so you can bail.
- `label` *(optional)* — display label.

Semantics:
- `at` / `in_minutes` only → fires once at that time.
- `condition` only → polls immediately until true.
- both → waits until the time, then starts polling the condition.

## Patterns by scenario

The predicate is just shell. Examples below are bash; if the `set_reminder`
response says `shell powershell` (native Windows without bash), use the
PowerShell variant shown in parentheses.

### CI/CD pipeline result
Capture the run id, then poll the API for completion:
```bash
# GitHub Actions (needs GH_TOKEN; assume run id stored in /tmp/run)
gh run watch "$(< /tmp/run)" --exit-status && [ -f /tmp/done ] || \
  (gh run view "$(< /tmp/run)" --json conclusion -q '.conclusion=="success"')
```
Simpler: write conclusion to a file from a webhook/`gh run watch` backgrounded
before arming, then test the file:
```bash
[ -f /tmp/ci-result ]
```
GitLab:
```bash
[ "$(curl -sf --header "PRIVATE-TOKEN: $CI_TOKEN" \
  "https://gitlab.com/api/v4/projects/$PID/pipelines/$PIPE/jobs" \
  | jq -r '.[].status' | sort -u | tr '\n' ',')" = "success," ]
```
Reminder:
```
set_reminder { condition: "[ -f /tmp/ci-result ]", poll_seconds: 30,
  timeout_minutes: 60, message: "CI finished. Read /tmp/ci-result, fetch the run logs if it failed, diagnose, and either fix or report." }
```

### Build / download / train by process exit
```bash
! pgrep -f 'webpack|cargo|make|aria2c'
```
PowerShell: `-not (Get-Process -Name webpack,cargo,make,aria2c -ErrorAction SilentlyContinue)`
Or if you started it and captured the PID (`./build.sh & echo $!` → `/tmp/pid`):
```bash
! kill -0 "$(< /tmp/pid)" 2>/dev/null
```

### File appeared / stopped growing (downloads)
```bash
[ -f dist/bundle.js ]                                   # appeared
[ "$(find /tmp/movie.mkv -mmin -0.2 2>/dev/null)" = "" ] # stable ~12s
```
PowerShell: `Test-Path dist/bundle.js`

### URL / service health
```bash
curl -sf http://localhost:8080/health
```
PowerShell: `try { (iwr http://localhost:8080/health -UseBasicParsing).StatusCode -eq 200 } catch { $false }`

### Log line appeared
```bash
grep -q 'BUILD SUCCESSFUL\|Deployment complete' build.log
```
PowerShell: `Select-String -Path build.log -Pattern 'BUILD SUCCESSFUL','Deployment complete' -Quiet`

### Clock time (market open, scheduled event)
```
set_reminder { at: "9:30", message: "Market is open. Pull quotes and run screening." }
```
Or as a condition (more flexible, e.g. weekdays only):
```bash
[ "$(date +%u)" -le 5 ] && [ "$(date +%H%M)" -ge 0930 ]
```

### Queue / external state
```bash
[ "$(redis-cli llen jobs)" -eq 0 ]          # queue drained
[ "$(kubectl get pod app -o jsonpath='{.status.phase}')" = Running ]
[ "$(aws s3 ls s3://bucket/done.flag)" ]    # artifact published
```

### Countdown (short task, no observable signal)
```
set_reminder { in_minutes: 5, message: "Re-check the task status now." }
```

## How to use

1. If the waitable thing needs launching, start it in the background first
   and write any handle (PID, run id, output path) to a file.
2. Call `set_reminder` with a `condition` matching the completion signal and a
   clear resume `message`.
3. **Stop.** Tell the user you're parking and will resume automatically. Do
   not poll, sleep, or keep calling tools.
4. When it fires you receive your `message` as a new user message — continue
   from there.

## Managing reminders

- `/reminders` — list pending in a bordered focused overlay; press `esc`, `q`, or `enter` to close it.
- `/cancel-reminder <id>` or the `cancel_reminder` tool — cancel one.
- Reminders persist across `/reload` and pi restarts.

## Choosing parameters

- Prefer a `condition` over a blind `in_minutes` timer — observe the real
  completion signal when at all possible.
- For long waits (market open, CI), raise `poll_seconds` (e.g. 60–300) to
  avoid noise.
- Set `timeout_minutes` whenever a stale wait should bail rather than hang
  forever; on timeout you get the message flagged so you can re-arm or pivot.

---
name: iris-agent-context
description: Use when Codex or Claude should split independent work into a parent-linked Iris terminal, or when navigating and closing child sessions in the Iris Agents tree.
---

# Iris parent-linked agent contexts

Before broad evidence gathering, an independent review, or an isolated experiment, evaluate whether the work should split. Split when it has its own bounded result and separate context or independent judgment is worth the briefing and review cost. Keep dependent implementation, small lookups, and shared-file work in the current context. Follow the current session's delegation permissions. Use native subagents for short bounded work; use this launcher when the child needs a durable or interactive Codex or Claude terminal.

Write a self-contained brief, then launch from the current live herdr pane:

```sh
node {{LAUNCHER}} launch --id JOB_ID --runtime codex --model MODEL --effort LEVEL --reason independent-work --brief /absolute/task/brief.md --cwd /absolute/workspace --name JOB_NAME
```

Use `--runtime claude` for Claude Code. Reasons are `independent-work`, `independent-review`, `separate-evidence`, and `isolated-trial`. Reuse the same job ID only for identical inputs. Use `--dry-run` to validate without creating a terminal. If creation is uncertain, inspect the returned receipt and exact pane before retrying. Do not use bare `herdr agent start` for a child that must appear under its parent, and never infer a parent from cwd, names, or timing.

In Iris, clicking a parent row shows only the parent's chat and clicking a child row shows only that child's chat. Previous/next agent navigation cycles top-level sessions; from a child it uses the top-level parent's position. A selected row clicked again, or its arrow, toggles descendants. Cmd+W closes only the selected pane after its terminal identity is checked; held-key repeats are ignored. Preserve a child's result before closing its exact pane.

## Non-interactive runs

A `codex exec` or `claude -p` started straight from a shell is only a process. Iris cannot show it, because herdr has no way to adopt a running process into a pane. Start such a run inside a child pane instead:

```sh
node {{RUNNER}} --runtime codex --label JOB_NAME -- codex exec -m MODEL "task"
```

This is transparent — stdin, stdout, stderr and the exit code match a direct run, and the two streams stay separate. The child gets its own tab, appears under its parent in the Agents tree, and its pane closes when the command ends. Outside herdr it runs the command unchanged. Use it whenever a script or tool of yours launches a subsession; a command typed straight into a shell is already wrapped for you.

The launcher uses the installed Iris application. Re-run `pnpm install:app` from the Iris source repository after updating Iris to refresh this managed skill and launcher package. New Codex and Claude sessions discover the installed skill; do not assume an already-running thread reloads it.

<!-- iris-agent-context-managed:v1 -->

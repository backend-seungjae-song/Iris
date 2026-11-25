---
name: iris-agent-context
description: Use by default for option comparisons, decisions, and multi-field input. Render an A2UI surface even when the user never mentions Iris or A2UI. Also use for parent-linked terminals, worktrees, and child session navigation.
---

# Iris parent-linked agent contexts

Before broad evidence gathering, an independent review, or an isolated experiment, evaluate whether the work should split. Split when it has its own bounded result and separate context or independent judgment is worth the briefing and review cost. Keep dependent implementation, small lookups, and shared-file work in the current context. Follow the current session's delegation permissions. Use native subagents for short bounded work; use this launcher when the child needs a durable or interactive Codex or Claude terminal.

Write a self-contained brief, then launch from the current live herdr pane:

```sh
node {{LAUNCHER}} launch --id JOB_ID --runtime codex --model MODEL --effort LEVEL --reason independent-work --brief /absolute/task/brief.md --cwd /absolute/workspace --name JOB_NAME
```

Use `--runtime claude` for Claude Code. Reasons are `independent-work`, `independent-review`, `separate-evidence`, and `isolated-trial`. Reuse the same job ID only for identical inputs. Use `--dry-run` to validate without creating a terminal. If creation is uncertain, inspect the returned receipt and exact pane before retrying. Do not use bare `herdr agent start` for a child that must appear under its parent, and never infer a parent from cwd, names, or timing.

In Iris, clicking a parent row shows only the parent's chat and clicking a child row shows only that child's chat. Previous/next agent navigation cycles top-level sessions; from a child it uses the top-level parent's position. A selected row clicked again, or its arrow, toggles descendants. Cmd+W closes only the selected pane after its terminal identity is checked; held-key repeats are ignored. Preserve a child's result before closing its exact pane.

## Worktrees

When your work needs its own git worktree, create it through the same launcher as the `launch` command above, using its `worktree` subcommand, instead of `git worktree add`:

```sh
node <launcher path from the launch command above> worktree --name NAME [--base BRANCH] [--branch BRANCH] [--repo /absolute/repo]
```

Run it from your own terminal session (your normal shell tool inside the herdr pane is fine). It records that pane as the session that created the worktree, so the Iris sidebar can show who made it; a worktree made with plain git shows the creator as unknown. It prints JSON with the new `path`. By default the folder is `<repo>-worktrees/NAME` on a new branch `feat/NAME` from the current branch. Afterwards, run your commands with that path as the working directory (for example `cd PATH && ...`, or `--cwd PATH` for a child context) so Iris also shows your session as running there. Leave removing the worktree to the user.

## Non-interactive runs

A `codex exec` or `claude -p` started straight from a shell is only a process. Iris cannot show it, because herdr has no way to adopt a running process into a pane. Start such a run inside a child pane instead:

```sh
node {{RUNNER}} --runtime codex --label JOB_NAME -- codex exec -m MODEL "task"
```

This is transparent — stdin, stdout, stderr and the exit code match a direct run, and the two streams stay separate. The child gets its own tab, appears under its parent in the Agents tree, and its pane closes when the command ends. Outside herdr it runs the command unchanged. Use it whenever a script or tool of yours launches a subsession; a command typed straight into a shell is already wrapped for you.

The launcher uses the installed Iris application. Re-run `pnpm install:app` from the Iris source repository after updating Iris to refresh this managed skill and launcher package. New Codex and Claude sessions discover the installed skill; do not assume an already-running thread reloads it.

## Prompt target registration

Iris adds tab, group, picked-element, and emulator delimiters to the chat input when the user designates a target in the app. The UserPromptSubmit hook registers only valid delimiters that arrive in the user's submitted message. Tab and group delimiters keep the existing handle before `~`; emulator delimiters use `@device:<udid>~<nonce>`. When several emulators are registered, every `app_*` tool call must include `device`.

## Interactive UI (A2UI v0.9 Basic Catalog)

When showing comparable options, asking for a decision, or collecting related inputs, emit a surface in this turn. The request need not name Iris, the chat view, or A2UI. For a read-only comparison use a Table or Cards. For a decision use a ChoicePicker and a submit Button. Ask short single-answer questions in chat. To display a surface, emit a fenced `a2ui` JSON block in your assistant response, as shown below. When the user submits it, continue the task with the returned action and values.

- **Lifecycle**: `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface` (`surfaceId`, `title`). Iris opens the surface in a console tab. The A2UI button just above the right edge of the message input reopens the tab.
- **Catalog (`https://a2ui.org/specification/v0_9/basic_catalog.json`)**: supports both flat v0.9 adjacency lists (`id`, `component`, `child`/`children` IDs, `{"@path":"/a/b"}`) and compact nested components:
  - Layout: `Row`, `Column`, `List`, `Card`, `Tabs` (`tabItems`), `Modal` (`entryPointChild`, `contentChild`), `Divider`
  - Display: `Text` (`h1` | `h2` | `h3` | `body` | `caption` | `code`), `Image` (`http`/`https` only), `Icon`, `Badge`, `KeyValue`, `Table`, `Progress`
  - Input/Action: `TextField`, `CheckBox`, `ChoicePicker` (`variant`: `"cards" | "chips" | "dropdown"`, `multiple`, `maxAllowedSelections`), `Slider`, `DateTimeInput`, `Button` (`variant`: `"primary" | "default" | "danger" | "ghost"`)
- **Action round-trip**: clicking a `Button` sends `[A2UI:<title>] <action> payload={...} data={...}` back into your terminal input with the bound `dataModel`.

```a2ui
{
  "type": "createSurface",
  "surfaceId": "confirm",
  "title": "설정 확인",
  "components": [
    { "type": "ChoicePicker", "label": "환경", "variant": "chips", "bind": "env", "options": ["staging", "prod"] },
    { "type": "Button", "variant": "primary", "label": "적용", "action": "apply" }
  ],
  "dataModel": { "env": "staging" }
}
```

<!-- iris-agent-context-managed:v1 -->

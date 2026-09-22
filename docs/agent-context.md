# Separate agent contexts

Before extensive evidence gathering, an independent review, or an isolated experiment, determine whether the work can produce a separate, bounded result. Keep dependent implementation and small lookups in the same context. The parent integrates the results. A child receives only the objective, relevant evidence, allowed scope, expected artifact, and stop conditions.

Use native subagents for short, bounded tasks. For work that needs its own interactive terminal and lifecycle, launch from the current Codex or Claude pane:

```sh
pnpm agent:context launch --id review-api --runtime codex --model MODEL --effort LEVEL --reason independent-review --brief /absolute/task/review.md --cwd /absolute/project --name API-review
```

`--runtime` accepts `codex` or `claude`. Reasons are `independent-work`, `independent-review`, `separate-evidence`, and `isolated-trial`. Choose model and effort from the installed runtime's supported catalog. `--dry-run` verifies identity without launching. The launcher adds no permission bypass flags; the child uses its runtime settings and the brief's authority boundary.

The caller must belong to the current pane's live runtime process. `HERDR_SOCKET_PATH` must agree with the socket derived from the Iris state directory/session. Native Codex workers sharing the parent's pane cannot use that pane's identity to launch a terminal. For development, pass the matching `IRIS_STATE_DIR` and `IRIS_HERDR_SESSION` settings.

Each job ID is scoped to the parent terminal. Repeating a completed launch with identical inputs returns the original receipt without creating another terminal. Different inputs under the same ID are rejected. Creation intent and result are stored under `stateHome()/agent-context/<socket-hash>/`. If the result is uncertain or lineage registration fails, inspect the saved receipt and live pane before recovery; retrying the same ID does not create an additional terminal. Preserve the result artifact before closing only the child pane recorded in the receipt.

Parent relationships are stored under `stateHome()/agent-lineage/<socket-hash>/`. Iris checks both live pane and terminal identities, workspace, runtime, and known session IDs. It reads only live terminal receipts when recomputing relationships and monitors atomic receipt publication to detect new relationships regardless of creation-event timing.

The Agents sidebar shows verified children under their parent, expanded by default. Clicking a different agent focuses and shows only that pane, even in a split terminal tab; clicking the selected agent again toggles descendants. The arrow also toggles descendants, and selecting a hidden child through existing navigation expands its ancestors. Existing native Claude subagents appear as informational descendants. Missing parents, outdated identities, and invalid/cyclic links do not hide sessions. Existing sessions without an explicit relationship remain top-level sessions. Dragging reorders single-pane tabs among siblings; it does not change parent relationships.

Verification: `pnpm test` includes launcher side effects/idempotency, lineage identity and watcher tests, and tree ordering/toggle/reveal tests. These checks verify mechanics; they do not establish that a model's split decisions improve quality or cost in every task.

Source files: [launcher](../bin/agent-context.mjs), [lineage join](../server/agent-lineage.js), [sidebar renderer](../web/js/herdr/agents.js).

Agent previous/next shortcuts cycle only top-level sessions. From a child they use its top-level parent's position. Cmd+W closes the selected pane only, checks its terminal identity, and ignores held-key repeats. Legacy whole-tab close requests are refused for split tabs.

`pnpm install:app` also installs the managed `iris-agent-context` skill for Codex and Claude Code. New sessions discover it in each runtime's `skills/` directory; existing personal guidance/settings remain untouched. Custom homes follow `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. The skill points to the launcher bundled inside `/Applications/Iris.app`, so it continues to work if the source checkout moves. Reinstalling refreshes only the Iris-managed skill; a conflicting user-owned skill is preserved and reported.

## Non-interactive subsessions

A `codex exec` or `claude -p` command started directly from a shell runs as a process without its own pane. herdr cannot assign an existing process to a pane, so the command does not appear in `herdr agent list` or the Agents sidebar. The parent pane shows `working` without identifying the command running inside it. To display such a command as a separate session, start it inside a child pane.

```sh
node bin/agent-run.mjs --runtime codex --label "job name" -- codex exec -m MODEL "task"
```

The wrapper preserves stdin, stdout, stderr and the exit code of a direct run. It keeps stdout and stderr separate because callers classify them independently. It creates a tab for the child in the parent's workspace, removes the tab's initial empty shell, reports the runtime to allow parent-child registration, and writes the lineage receipt. The pane and its tab close when the command ends. Outside herdr, or when the runtime is not `codex`/`claude`, the wrapper executes the command unchanged.

Use the wrapper for every non-interactive `codex`/`claude` command that should appear in the tree, including commands launched by scripts. A shell hook can rewrite commands entered in an interactive shell, but it cannot intercept subsessions started inside scripts. Those call sites must invoke the wrapper directly.

Working files are stored under `stateHome()/agent-run/<socket-hash>/<job>/` and are kept only when the command fails or `--keep` is given.

Verification: `pnpm test` covers the shell quoting, the env keys withheld from the child, the stream separation and exit-code publication order in the pane script, and the configuration that includes the wrapper in the installed app.

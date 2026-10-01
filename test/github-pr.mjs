import test from "node:test";
import assert from "node:assert/strict";
import { commandEnv, createGithubPrHandler, normalizePullRequest } from "../server/github-pr-handler.js";

const ROOT = "/work/iris";
const PR = {
  number: 42, title: "검사 상태 표시", url: "https://github.com/owner/repo/pull/42", state: "OPEN",
  headRefName: "feature", baseRefName: "main", author: { login: "author" }, body: "설명",
  comments: [{ author: { login: "reviewer" }, body: "수정 요청", createdAt: "2026-09-26T00:00:00Z" }],
  reviews: [], files: [{ path: "src/main.js", additions: 2, deletions: 1 }],
  statusCheckRollup: [
    { name: "test", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/repo/actions/runs/123/job/4" },
    { name: "lint", conclusion: "SUCCESS", detailsUrl: "https://evil.test/actions/runs/999" },
  ],
};

function harness({ local = true, gh = JSON.stringify(PR), draftWriter, realpath = (value) => value, patch = "@@ -1 +1 @@\n-const old = 1;\n+const next = 2;", filesPages } = {}) {
  const commands = [], messages = [];
  const run = async (file, args, options) => {
    commands.push({ file, args, options });
    if (file === "git") return args.includes("--show-toplevel") ? ROOT + "\n" : "feature\n";
    if (args[0] === "run") return "failed step\n";
    if (args[0] === "api" && args[1].includes("/files?")) return JSON.stringify(filesPages || [[{ filename: "src/main.js", sha: "abc", patch }]]);
    if (args[0] === "api") return JSON.stringify([{ user: { login: "inline-reviewer" }, body: "인라인 수정 요청", path: "src/main.js", line: 5, created_at: "2026-09-26T01:00:00Z" }]);
    if (gh instanceof Error) throw gh;
    return gh;
  };
  const handler = createGithubPrHandler({ run, realpath, allowed: (value) => value === ROOT || value.startsWith(ROOT + "/"), draftWriter });
  const ws = { _local: local, send(raw) { messages.push(JSON.parse(raw)); } };
  return { handler, ws, commands, messages };
}

test("current branch PR returns bounded conversation, checks and files", async () => {
  const h = harness();
  await h.handler(h.ws, { type: "githubpr.status", requestId: "a", path: ROOT, expectRoot: ROOT, branch: "feature" });
  assert.equal(h.messages[0].ok, true);
  assert.equal(h.messages[0].pr.number, 42);
  assert.equal(h.messages[0].pr.checks[0].runId, "123");
  assert.equal(h.messages[0].pr.checks[1].runId, null);
  assert.equal(h.messages[0].pr.comments[0].body, "수정 요청");
  assert.equal(h.messages[0].pr.reviewComments[0].path, "src/main.js");
  assert.deepEqual(h.commands.map((x) => [x.file, x.args[0]]), [["git", "-C"], ["git", "-C"], ["gh", "pr"], ["gh", "api"]]);
  assert.equal(h.commands[2].options.cwd, ROOT);
});

test("local and realpath boundaries reject requests before gh", async () => {
  const remote = harness({ local: false });
  await remote.handler(remote.ws, { type: "githubpr.status", path: ROOT });
  assert.equal(remote.messages[0].error.code, "local_only");
  assert.equal(remote.commands.length, 0);

  const link = harness({ realpath: () => "/outside" });
  await link.handler(link.ws, { type: "githubpr.status", path: ROOT });
  assert.equal(link.messages[0].error.code, "path_denied");
  assert.equal(link.commands.length, 0);

  const stale = harness();
  await stale.handler(stale.ws, { type: "githubpr.status", path: ROOT, branch: "main" });
  assert.equal(stale.messages[0].error.code, "stale_branch");
  assert.equal(stale.commands.some((x) => x.file === "gh"), false);
});

test("failure log accepts only a run linked by this PR", async () => {
  const h = harness();
  await h.handler(h.ws, { type: "githubpr.log", requestId: "a", path: ROOT, branch: "feature", runId: "999" });
  assert.equal(h.messages[0].error.code, "invalid_run");
  assert.equal(h.commands.some((x) => x.args[0] === "run"), false);
  await h.handler(h.ws, { type: "githubpr.log", requestId: "b", path: ROOT, branch: "feature", runId: "123" });
  assert.equal(h.messages[1].log, "failed step\n");
  assert.deepEqual(h.commands.at(-1).args, ["run", "view", "123", "--log-failed"]);
});

test("missing gh, missing PR and auth have distinct errors", async () => {
  for (const [error, code] of [
    [Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "gh_missing"],
    [Object.assign(new Error("no pull requests found for branch"), { stderr: "no pull requests found for branch" }), "no_pr"],
    [Object.assign(new Error("auth"), { stderr: "run gh auth login" }), "auth_required"],
  ]) {
    const h = harness({ gh: error });
    await h.handler(h.ws, { type: "githubpr.status", path: ROOT, branch: "feature" });
    assert.equal(h.messages[0].error.code, code);
  }
});

test("draft only forwards to the injected local writer with request identity", async () => {
  const calls = [];
  const h = harness({ draftWriter: async (input) => { calls.push(input); return { paneId: input.paneId }; } });
  await h.handler(h.ws, { type: "githubpr.draft", requestId: "abc", paneId: "pane", terminalId: "term", spaceId: "space", text: "수정 요청" });
  assert.equal(h.messages[0].ok, true);
  assert.deepEqual(calls[0], { requestId: "githubpr:abc", paneId: "pane", terminalId: "term", spaceId: "space", text: "수정 요청" });
  assert.equal(h.commands.length, 0);

  const remote = harness({ local: false, draftWriter: async (input) => calls.push(input) });
  await remote.handler(remote.ws, { type: "githubpr.draft", requestId: "def", text: "x" });
  assert.equal(remote.messages[0].error.code, "local_only");
  assert.equal(calls.length, 1);
});

test("normalization truncates external text and list lengths", () => {
  const result = normalizePullRequest({ ...PR, body: "x".repeat(30000), files: Array.from({ length: 600 }, (_, i) => ({ path: `f${i}` })) }, ROOT, "feature");
  assert.equal(result.body.length, 20000);
  assert.equal(result.files.length, 500);
});

test("Dock에서 연 앱의 기본 PATH에서도 Homebrew gh 위치를 찾는다", () => {
  const env = commandEnv({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/h" });
  assert.deepEqual(env.PATH.split(":"), ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"]);
  assert.equal(env.HOME, "/h");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
});


test("PR diff reads the selected GitHub file and rejects stale PRs and unrelated files", async () => {
  const h = harness({ filesPages: [[], [{ filename: "src/main.js", sha: "new-sha", patch: "@@ -1 +1 @@\n-old\n+new" }]] });
  await h.handler(h.ws, { type: "githubpr.diff", requestId: "diff", path: ROOT, branch: "feature", number: 42, file: "src/main.js" });
  assert.equal(h.messages[0].ok, true);
  assert.match(h.messages[0].patch, /-old\n\+new/);
  assert.equal(h.messages[0].sha, "new-sha");
  assert.deepEqual(h.commands.at(-1).args, ["api", "repos/{owner}/{repo}/pulls/42/files?per_page=100", "--paginate", "--slurp"]);
  for (const [number, file, code] of [[43, "src/main.js", "stale_pr"], [42, "../secret", "invalid_file"]]) {
    const blocked = harness();
    await blocked.handler(blocked.ws, { type: "githubpr.diff", path: ROOT, number, file });
    assert.equal(blocked.messages[0].error.code, code);
    assert.equal(blocked.commands.some(x => x.args.includes("--paginate")), false);
  }
});

test("PR diff reports omitted patches, deleted response files and malformed pagination", async () => {
  for (const [options, code] of [[{ patch: null }, "patch_unavailable"], [{ filesPages: [[]] }, "stale_file"], [{ filesPages: [{ filename: "src/main.js" }] }, "bad_response"]]) {
    const h = harness(options);
    await h.handler(h.ws, { type: "githubpr.diff", path: ROOT, number: 42, file: "src/main.js" });
    assert.equal(h.messages[0].ok, false);
    assert.equal(h.messages[0].error.code, code);
  }
});

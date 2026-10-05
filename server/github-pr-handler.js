// 소유 범위: 로컬 githubpr.* 요청의 저장소 판정, 읽기 전용 gh 실행과 초안 전달.
// 제공 API: createGithubPrHandler, initGithubPrHandler, handleGithubPr, normalizePullRequest, commandEnv.
// 의존 대상: runtime-state 허용 경로, Node execFile, 주입된 에이전트 초안 작성자.
// 유지 조건: 실제 경로·브랜치를 재확인하고 gh 인자를 고정한다. 명령마다 시간·출력 한도를 둔다.
// 영향 범위: PR 상태·실패 로그·초안 WebSocket 응답과 github-pr 화면.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathAllowed } from "./runtime-state.js";

const exec = promisify(execFile);
const MAX_JSON = 2 * 1024 * 1024;
const MAX_LOG = 256 * 1024;
const VIEW_FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,author,body,comments,reviews,files,statusCheckRollup";

// Dock·Spotlight 로 연 앱의 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐. Homebrew 로 설치한 gh 경로 보강
export function commandEnv(env = process.env) {
  const windows = process.platform === "win32";
  const pathKey = windows ? Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH" : "PATH";
  const extra = windows ? [env.ProgramFiles && path.join(env.ProgramFiles, "GitHub CLI")] : ["/opt/homebrew/bin", "/usr/local/bin"];
  const PATH = [env[pathKey] || "", ...extra].filter(Boolean).join(windows ? path.delimiter : ":");
  return { ...env, [pathKey]: PATH, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
}

async function runCommand(file, args, { cwd, maxBuffer = MAX_JSON } = {}) {
  const { stdout } = await exec(file, args, { cwd, encoding: "utf8", timeout: 12000, maxBuffer, windowsHide: true,
    env: commandEnv() });
  return stdout;
}

function fail(code, message) { return { code, message }; }
function commandError(error, command) {
  const message = String(error?.stderr || error?.message || "");
  if (error?.code === "ENOENT" && command === "gh") return fail("gh_missing", "GitHub CLI(gh)가 설치되어 있지 않습니다.");
  if (error?.killed || error?.code === "ETIMEDOUT") return fail("timeout", "GitHub 응답 시간이 초과되었습니다. 다시 시도하세요.");
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(message)) return fail("output_limit", "GitHub 응답이 너무 커서 표시할 수 없습니다.");
  // 원격 없음·GitHub 아닌 원격. 뒤 문구에 "gh auth login" 이 있어 로그인 판정보다 먼저 대조
  if (/no git remotes found/i.test(message)) return fail("no_remote", "이 저장소에 원격(remote)이 없어 PR 을 찾을 수 없습니다.");
  if (/none of the git remotes .*known GitHub host/i.test(message)) return fail("not_github", "이 저장소의 원격이 GitHub 가 아니어서 PR 을 찾을 수 없습니다.");
  if (/authentication required|not logged in|gh auth login|authenticate|401 Unauthorized|HTTP 401/i.test(message)) return fail("auth_required", "gh auth login 으로 GitHub에 로그인하세요.");
  if (/no pull requests found|could not find a pull request|no pull request found|not found for current branch/i.test(message)) return fail("no_pr", "현재 브랜치에 연결된 PR이 없습니다.");
  return fail("command_failed", `${command === "gh" ? "GitHub" : "Git"} 정보를 읽지 못했습니다.`);
}

function brief(value, limit = 12000) { return String(value ?? "").slice(0, limit); }
function person(value) { return brief(value?.login || value?.name || "", 120); }
function reviewComment(value) {
  return {
    author: person(value.user), body: brief(value.body, 12000), createdAt: brief(value.created_at, 80),
    path: brief(value.path, 1000), line: Number(value.line || value.original_line) || null,
    url: brief(value.html_url, 1000),
  };
}
function runIdFromUrl(value, pullUrl) {
  try {
    const url = new URL(value), pr = new URL(pullUrl);
    if (url.protocol !== "https:" || pr.protocol !== "https:" || url.origin !== pr.origin) return null;
    const repo = /^\/(?:[^/]+)\/(?:[^/]+)\//.exec(pr.pathname)?.[0];
    if (!repo) return null;
    return new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}actions/runs/(\\d+)(?:/|$)`).exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

export function normalizePullRequest(raw, root, branch, reviewComments = []) {
  if (!raw || !Number.isSafeInteger(raw.number) || raw.number < 1) throw new Error("invalid PR response");
  const checks = (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).slice(0, 150).map((item) => {
    const conclusion = brief(item.conclusion || item.state || item.status || "", 40);
    const detailsUrl = brief(item.detailsUrl || item.targetUrl || "", 1000);
    return {
      name: brief(item.name || item.context || item.workflowName || "검사", 200), conclusion,
      status: brief(item.status || "", 40), detailsUrl, runId: runIdFromUrl(detailsUrl, raw.url),
    };
  });
  return {
    root, branch, number: raw.number, title: brief(raw.title, 500), url: brief(raw.url, 1000),
    state: brief(raw.state, 40), isDraft: !!raw.isDraft, head: brief(raw.headRefName, 300),
    base: brief(raw.baseRefName, 300), author: person(raw.author), body: brief(raw.body, 20000),
    comments: (Array.isArray(raw.comments) ? raw.comments : []).slice(-100).map((x) => ({
      author: person(x.author), body: brief(x.body, 12000), createdAt: brief(x.createdAt, 80), url: brief(x.url, 1000),
    })),
    reviews: (Array.isArray(raw.reviews) ? raw.reviews : []).slice(-100).map((x) => ({
      author: person(x.author), body: brief(x.body, 12000), state: brief(x.state, 40),
      submittedAt: brief(x.submittedAt, 80), url: brief(x.url, 1000),
    })),
    reviewComments: (Array.isArray(reviewComments) ? reviewComments : []).slice(0, 100).map(reviewComment),
    files: (Array.isArray(raw.files) ? raw.files : []).slice(0, 500).map((x) => ({
      path: brief(x.path, 1000), additions: Number(x.additions) || 0, deletions: Number(x.deletions) || 0,
    })),
    checks,
  };
}

export function createGithubPrHandler({ run = runCommand, realpath = fs.realpathSync, allowed = isPathAllowed, draftWriter } = {}) {
  async function context(message) {
    if (typeof message.path !== "string" || !path.isAbsolute(message.path) || !allowed(message.path))
      throw fail("path_denied", "스페이스 폴더가 없습니다.");
    let dir;
    try { dir = realpath(message.path); } catch { throw fail("path_missing", "폴더를 찾을 수 없습니다."); }
    if (!allowed(dir)) throw fail("path_denied", "허용되지 않은 폴더입니다.");
    let root, branch;
    try {
      root = realpath((await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { cwd: dir })).trim());
      branch = (await run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })).trim();
    } catch (error) { throw commandError(error, "git"); }
    if (!allowed(root)) throw fail("path_denied", "저장소가 스페이스 폴더 밖에 있습니다.");
    if (message.expectRoot && path.resolve(message.expectRoot) !== root) throw fail("stale_repo", "저장소가 바뀌었습니다. 새로고침 후 다시 시도하세요.");
    if (message.branch && message.branch !== branch) throw fail("stale_branch", "브랜치가 바뀌었습니다. 새로고침 후 다시 시도하세요.");
    if (!branch) throw fail("detached_head", "현재 브랜치를 확인할 수 없습니다.");
    return { root, branch };
  }
  async function view(root, branch) {
    let output;
    try { output = await run("gh", ["pr", "view", "--json", VIEW_FIELDS], { cwd: root }); }
    catch (error) { throw commandError(error, "gh"); }
    let pr;
    try { pr = normalizePullRequest(JSON.parse(output), root, branch); }
    catch { throw fail("bad_response", "GitHub PR 정보를 읽지 못했습니다."); }
    try {
      const host = new URL(pr.url).hostname;
      if (host !== "github.com") throw fail("unsupported_host", "이 GitHub 서버의 줄 의견은 읽을 수 없습니다.");
      const comments = await run("gh", ["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments?per_page=100`, "--hostname", host], { cwd: root });
      const parsed = JSON.parse(comments);
      if (!Array.isArray(parsed)) throw new Error("invalid review comments");
      pr.reviewComments = parsed.slice(0, 100).map(reviewComment);
      pr.reviewCommentsLimited = parsed.length >= 100;
    } catch (error) {
      pr.reviewCommentsError = error?.code === "unsupported_host" ? error.message : "줄 의견을 읽지 못했습니다.";
    }
    return pr;
  }
  return async function handle(ws, message) {
    const op = typeof message?.type === "string" ? message.type.slice("githubpr.".length) : "";
    const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 100) : "";
    const type = `githubpr-${op}`;
    const send = (result) => { try { ws.send(JSON.stringify({ type, requestId, ...result })); } catch {} };
    if (!["status", "log", "diff", "draft"].includes(op)) { send({ ok: false, error: fail("unknown_op", "알 수 없는 요청입니다.") }); return; }
    if (!ws?._local) { send({ ok: false, error: fail("local_only", "원격 연결에서는 쓸 수 없습니다.") }); return; }
    try {
      if (op === "draft") {
        if (!/^[A-Za-z0-9:_-]{1,100}$/.test(requestId)) throw fail("invalid_request", "잘못된 요청입니다.");
        if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 12000)
          throw fail("invalid_draft", "보낼 내용은 1~12,000자여야 합니다.");
        if (!draftWriter) throw fail("draft_unavailable", "에이전트 입력창에 넣을 수 없습니다.");
        const result = await draftWriter({ requestId: `githubpr:${requestId}`, paneId: message.paneId,
          terminalId: message.terminalId, spaceId: message.spaceId, text: message.text });
        send({ ok: true, result });
        return;
      }
      const { root, branch } = await context(message);
      const pr = await view(root, branch);
      if (op === "status") { send({ ok: true, pr }); return; }
      if (op === "diff") {
        if (new URL(pr.url).hostname !== "github.com") throw fail("unsupported_host", "이 GitHub 서버의 diff는 읽을 수 없습니다.");
        if (message.number !== pr.number) throw fail("stale_pr", "PR이 바뀌었습니다. 새로고침 후 다시 시도하세요.");
        if (typeof message.file !== "string" || !pr.files.some((item) => item.path === message.file))
          throw fail("invalid_file", "이 PR의 변경 파일을 선택하세요.");
        let pages;
        try {
          const output = await run("gh", ["api", `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`, "--paginate", "--slurp"], { cwd: root });
          pages = JSON.parse(output);
        } catch (error) { throw commandError(error, "gh"); }
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw fail("bad_response", "변경 파일을 읽지 못했습니다.");
        const file = pages.flat().find((item) => item.filename === message.file);
        if (!file) throw fail("stale_file", "PR의 변경 파일이 바뀌었습니다. 새로고침하세요.");
        if (typeof file.patch !== "string" || !file.patch.trim())
          throw fail("patch_unavailable", "GitHub에서 이 파일의 diff를 제공하지 않습니다. 바이너리 또는 큰 파일은 GitHub에서 확인하세요.");
        send({ ok: true, root, branch, number: pr.number, file: file.filename, sha: brief(file.sha, 100), patch: file.patch, base: pr.base });
        return;
      }
      const runId = String(message.runId || "");
      if (!/^\d{1,18}$/.test(runId) || !pr.checks.some((check) => check.runId === runId))
        throw fail("invalid_run", "이 PR의 검사를 선택하세요.");
      let output;
      try { output = await run("gh", ["run", "view", runId, "--log-failed"], { cwd: root, maxBuffer: MAX_LOG }); }
      catch (error) { throw commandError(error, "gh"); }
      send({ ok: true, root, branch, runId, log: brief(output, MAX_LOG) });
    } catch (error) {
      const known = error?.code && error?.message;
      send({ ok: false, error: known ? fail(String(error.code), brief(error.message, 300)) : fail("internal", "PR 정보를 읽지 못했습니다.") });
    }
  };
}

let active = createGithubPrHandler();
export function initGithubPrHandler(options) { active = createGithubPrHandler(options); }
export function handleGithubPr(ws, message) { void active(ws, message); }

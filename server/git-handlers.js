import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  clearGitStatusCache,
  isPathAllowed as fsPathAllowed,
  requestRecompute as recompute,
} from "./runtime-state.js";

// git.* WebSocket 요청의 저장소 경계·명령 실행·응답 조립을 맡는 leaf handler.
//
// 소유 범위
//   Git root 해석, status/diff 파싱, Base 브랜치 대비 목록(branchDiff), mutation whitelist와
//   git.* namespace 분기·응답 순서.
//
// 제공 API
//   entry의 exact namespace dispatch가 호출하는 handleGit.
//
// 의존 대상
//   node:path·child_process와 runtime-state의 단일 경로 판정·Git 상태 cache clear·recompute port.
//
// 유지 조건
//   mutation은 로컬 연결만 허용하고 expectRoot 불일치·root 밖 path를 먼저 거절한다.
//   명령·timeout·응답 순서를 바꾸지 않으며 다른 handler를 import하거나 호출하지 않는다.
//
// 영향 범위
//   server/index.js의 git.* dispatch, fs.list가 runtime-state cache를 통해 내보내는 Git 표식,
//   web/js/devtool/source-control.js·web/js/explorer/tree.js와 fs-path-boundary·Git smoke 계약.

function gitRoot(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 1500 }).trim(); }
  catch { return ""; }
}
function git(root, args, timeout = 20000) {
  try { const out = execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }); return { ok: true, out, err: "" }; }
  catch (e) { return { ok: false, out: (e.stdout || "").toString(), err: (e.stderr || e.message || "").toString() }; }
}
// 폴더 아래에서 .git 이 있는 위치를 모은다. pane 을 띄운 적 없는 저장소는 후보가 될 방법이
// 없어서, 스페이스 안에 저장소가 여럿이면 그중 하나만 보인다.
// 스페이스 폴더 바로 아래까지만 찾는다. 더 깊이 찾으면 작업 폴더에 받아 둔 저장소까지 목록에 나온다.
// 개수도 제한한다. 큰 트리에서 이 탐색이 몇 초씩 걸리면 그동안 화면이 비어 있다.
const REPO_SCAN_DEPTH = 1;
const REPO_SCAN_MAX = 40;
const REPO_SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".turbo", ".cache", "vendor", "Pods", "target", ".venv", "venv", "__pycache__"]);
export function nestedRepos(dir, { depth = REPO_SCAN_DEPTH, max = REPO_SCAN_MAX, readdir, isDir } = {}) {
  const list = readdir || ((d) => fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name));
  const hasGit = isDir || ((d) => { try { return fs.existsSync(path.join(d, ".git")); } catch { return false; } });
  const out = [];
  const walk = (d, left) => {
    if (out.length >= max) return;
    let kids = [];
    try { kids = list(d); } catch { return; }
    for (const name of kids) {
      if (out.length >= max) return;
      if (REPO_SKIP.has(name)) continue;
      const abs = path.join(d, name);
      if (hasGit(abs)) out.push(abs);
      if (left > 1) walk(abs, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}
// 개행이 든 경로도 -z 출력으로 구분한다. 브랜치가 없는 항목은 detached HEAD다.
function worktreeEntries(root) {
  const result = git(root, ["worktree", "list", "--porcelain", "-z"], 1500);
  if (!result.ok) return [];
  const entries = [];
  for (const field of result.out.split("\0")) {
    if (field.startsWith("worktree ")) entries.push({ root: field.slice(9), branch: "" });
    else if (field.startsWith("branch refs/heads/") && entries.length) entries.at(-1).branch = field.slice(18);
  }
  return entries.filter((entry) => fs.existsSync(entry.root));
}
export function linkedWorktrees(dir) {
  const root = gitRoot(dir);
  return root ? worktreeEntries(root).map((entry) => entry.root) : [];
}
function gitCodeOf(c) { return ({ M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U" })[c] || c; }
// reqPath = 화면이 요청한 폴더. 응답에 포함해야 화면이 그 폴더가 어느 저장소로 해석됐는지
// 기억할 수 있다. 중첩 저장소의 .git이 사라지면 같은 폴더가 다른 저장소로 해석되기 때문이다.
export function gitStatusRich(root, reqPath) {
  // -z: 한글 등 비ASCII 경로를 "\355\225..." 로 감싸지 않고 그대로 받음. 이름 바뀜은 새 경로 뒤에 옛 경로가 따로 옴
  const r = git(root, ["status", "--porcelain=v1", "-z", "-uall", "--branch"]);
  const staged = [], changes = []; let branch = "", ahead = 0, behind = 0;
  const fields = (r.out || "").split("\0");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith("## ")) {
      // 커밋이 없는 브랜치는 "## No commits yet on main"(git 2.28 이전은 "Initial commit on")로 온다.
      // 앞말을 떼지 않으면 첫 낱말 "No" 가 브랜치 이름이 된다.
      const b = line.slice(3).replace(/^(?:No commits yet|Initial commit) on /, "");
      branch =b.split("...")[0].split(" ")[0] || "";
      const ma = b.match(/ahead (\d+)/); if (ma) ahead = +ma[1];
      const mb = b.match(/behind (\d+)/); if (mb) behind = +mb[1];
      continue;
    }
    const x = line[0], y = line[1], rel = line.slice(3);
    const old = "RC".includes(x) || "RC".includes(y) ? fields[++i] || "" : "";
    const abs = path.join(root, rel);
    if (x === "?" && y === "?") { changes.push({ rel, abs, code: "U", untracked: true }); continue; }
    // 옛 경로를 함께 넘겨야 diff 가 이름 바뀜으로 짝지음. 새 경로만이면 통째 추가로 보임
    if (x !== " " && x !== "?") staged.push({ rel, abs, code: gitCodeOf(x), ...("RC".includes(x) && old ? { oldRel: old } : {}) });
    if (y !== " " && y !== "?") changes.push({ rel, abs, code: gitCodeOf(y), untracked: false });
  }
  // branches = 전환할 수 있는 로컬 브랜치. 커밋·전환 뒤에 오는 status 에 함께 실어 목록이 따로 낡지 않게 한다.
  return { type: "git-status", root, path: reqPath || root, isRepo: true, branch, ahead, behind, staged, changes,
    base: defaultBase(root, gitBranchRefs(root)), // 화면이 레포마다 어느 브랜치에서 갈라졌는지 표시
    branches: gitBranchRefs(root, ["refs/heads"]),
    worktrees: worktreeEntries(root).map((entry) => ({ branch: entry.branch, root: fsPathAllowed(entry.root) ? entry.root : null })) };
}
// Base 브랜치 후보는 로컬·원격 브랜치 목록이다. 화면이 보낸 base 는 이 목록에 있을 때만 git 에
// 넘긴다. 목록 밖 문자열을 그대로 넘기면 "--output=..." 같은 값이 옵션으로 해석된다.
// scopes 로 로컬 브랜치만 고를 수 있다. 브랜치 전환 목록은 로컬만 쓴다. 원격 이름으로 전환하면
// 브랜치가 아닌 분리된 HEAD 가 된다.
export function gitBranchRefs(root, scopes = ["refs/heads", "refs/remotes"]) {
  const r = git(root, ["for-each-ref", "--format=%(refname)", ...scopes]);
  const out = [];
  for (const ref of (r.out || "").split("\n")) {
    if (!ref || ref.endsWith("/HEAD")) continue;
    if (ref.startsWith("refs/heads/")) out.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/")) out.push(ref.slice(13));
  }
  return out;
}
// 기본 Base: 지금 브랜치가 갈라져 나온 브랜치. 후보(origin/HEAD 가 가리키는 브랜치, 흔한 이름 순·원격 먼저) 중
// 갈라진 뒤 커밋이 가장 적은 것, 같으면 앞 후보. develop 에서 딴 브랜치를 main 과 비교하면 팀이 develop 에 올린
// 커밋까지 섞여 내 변경이 묻힘. 지금 브랜치 자신과 그 원격은 다른 후보가 없을 때만 씀
export function defaultBase(root, refs) {
  const cands = [];
  const add = (b) => { if (b && refs.includes(b) && !cands.includes(b)) cands.push(b); };
  const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).out.trim();
  if (head.startsWith("refs/remotes/")) add(head.slice(13));
  for (const n of ["main", "master", "develop", "dev"]) { add("origin/" + n); add(n); }
  const cur = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).out.trim();
  let best = "", bestCount = Infinity;
  for (const b of cands) {
    if (cur && (b === cur || b === "origin/" + cur)) continue;
    const r = git(root, ["rev-list", "--count", b + "..HEAD"]); // b 는 refs 목록 안의 이름만
    const n = r.ok ? Number(r.out.trim()) : NaN;
    if (Number.isFinite(n) && n < bestCount) { best = b; bestCount = n; }
  }
  return best || cands.find((b) => b !== cur) || ""; // 다른 후보가 없으면(main 위) 자기 원격과 비교
}
// base·mode 로 비교 기준을 정한다. committed = base...HEAD(분기점부터 HEAD 까지 커밋된 것),
// worktree = 분기점부터 지금 디스크 상태까지(커밋 전 변경 포함).
function branchCompare(root, base, mode) {
  const refs = gitBranchRefs(root);
  const b = base ? String(base) : defaultBase(root, refs);
  if (!b) return { refs, base: "", error: "Base 브랜치를 찾지 못했습니다." };
  if (!refs.includes(b)) return { refs, base: b, error: `브랜치가 없습니다: ${b}` };
  const mb = git(root, ["merge-base", b, "HEAD"]);
  if (!mb.ok || !mb.out.trim()) return { refs, base: b, error: `${b} 와 공통 조상이 없습니다.` };
  const range = mode === "worktree" ? [mb.out.trim()] : [mb.out.trim(), "HEAD"];
  return { refs, base: b, range };
}
// --name-status -z 출력: 상태 뒤에 경로 하나, 이름 바뀜·복사(R·C)는 경로 둘(옛 이름, 새 이름).
export function parseNameStatusZ(out) {
  const parts = String(out || "").split("\0");
  const files = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++]; if (!st) continue;
    const c = st[0];
    if (c === "R" || c === "C") { const from = parts[i++], to = parts[i++]; if (to) files.push({ code: c, rel: to, oldRel: from }); }
    else { const rel = parts[i++]; if (rel) files.push({ code: gitCodeOf(c), rel }); }
  }
  return files;
}
function gitBranchDiff(root, reqPath, base, mode) {
  const m = mode === "worktree" ? "worktree" : "committed";
  const cmp = branchCompare(root, base, m);
  const head = { type: "git-branch-diff", root, path: reqPath || root, mode: m, base: cmp.base, bases: cmp.refs };
  if (cmp.error) return { ...head, files: [], error: cmp.error };
  const r = git(root, ["diff", "--name-status", "-z", "-M", ...cmp.range]);
  if (!r.ok) return { ...head, files: [], error: (r.err || "diff 실패").trim() };
  const files = parseNameStatusZ(r.out);
  // 작업 트리 기준이면 아직 추적하지 않는 새 파일도 분기점 이후의 변경이다.
  if (m === "worktree") {
    const u = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const rel of (u.out || "").split("\0")) if (rel) files.push({ code: "U", rel, untracked: true });
  }
  for (const f of files) f.abs = path.join(root, f.rel);
  return { ...head, files };
}
const GIT_MUTATIONS = new Set(["stage", "unstage", "stageAll", "discard", "commit", "push", "pull", "checkout"]);
// 응답에는 항상 어느 저장소의 결과인지 남긴다. 화면이 저장소를 여러 개 동시에 관리해서,
// root가 없으면 성공·실패 알림이 어느 섹션 것인지 붙일 데가 없다. root를 아직 모르는 단계(경로
// 거부)에서는 요청한 폴더(path)를 대신 실어 그 후보를 지울 수 있게 한다.
export function handleGit(ws, msg) {
  const op = msg.type.slice(4); // "git." 뒤
  const dir = msg.path || msg.root;
  if (!dir || !fsPathAllowed(dir)) { ws.send(JSON.stringify({ type: "git-error", op, path: dir || "", error: "허용되지 않은 경로" })); return; }
  // 하위 저장소 찾기. 이 op 는 그 폴더가 저장소가 아니어도 응답해야 하므로 아래 gitRoot 판정보다 앞에
  // 둔다. 스페이스 폴더 자체는 저장소가 아니고 그 안에 저장소가 여럿인 경우가 흔하다.
  if (op === "repos") {
    const repos = nestedRepos(dir);
    const worktrees = [...new Set([dir, ...repos].flatMap(linkedWorktrees))].filter(fsPathAllowed);
    ws.send(JSON.stringify({ type: "git-repos", path: dir, repos, worktrees })); return;
  }
  if (GIT_MUTATIONS.has(op) && !ws._local) { ws.send(JSON.stringify({ type: "git-error", op, path: dir, error: "원격에서는 git 조작 불가(AC5)" })); return; }
  const root = gitRoot(dir);
  if (!root) { ws.send(JSON.stringify({ type: "git-status", root: dir, path: dir, isRepo: false })); return; }
  // 화면이 지정한 저장소와 현재 해석된 저장소가 다르면 실행하지 않는다. 중첩 저장소의 .git이
  // 사라지면 같은 경로가 부모 저장소로 해석되고, 그때 stageAll·commit이 부모 저장소 전체를 변경한다.
  // 화면이 보고 있던 것과 다른 저장소를 조작하는 것은 어떤 경우에도 사용자의 의도가 아니다.
  if (GIT_MUTATIONS.has(op) && msg.expectRoot && path.resolve(msg.expectRoot) !== root) {
    ws.send(JSON.stringify({ type: "git-error", op, root, path: dir,
      error: `이 폴더는 지금 ${root} 저장소입니다(화면은 ${msg.expectRoot} 기준). 새로고침 후 다시 하세요.` }));
    return;
  }
  const inRoot = (abs) => { const a = path.resolve(abs); return fsPathAllowed(a) && (a === root || a.startsWith(root + path.sep)); };
  const safeRels = (msg.paths || []).map(String).filter((r) => inRoot(path.resolve(root, r)));
  try {
    if (op === "status") { ws.send(JSON.stringify(gitStatusRich(root, dir))); return; }
    if (op === "branchDiff") { ws.send(JSON.stringify(gitBranchDiff(root, dir, msg.base, msg.mode))); return; }
    if (op === "diff") {
      const abs = msg.file;
      if (!abs || !inRoot(abs)) { ws.send(JSON.stringify({ type: "git-diff", root, file: abs || "", error: "허용되지 않은 경로" })); return; }
      const rel = path.relative(root, path.resolve(abs));
      let patch = "";
      // Base 대비 보기에서 연 파일. 응답에 mode·base 를 되돌려야 화면이 같은 파일의 다른 보기 탭과 구분한다.
      if (msg.mode) {
        const mode = msg.mode === "worktree" ? "worktree" : "committed";
        const cmp = branchCompare(root, msg.base, mode);
        const head = { type: "git-diff", root, file: abs, mode, base: msg.base || "" };
        if (cmp.error) { ws.send(JSON.stringify({ ...head, error: cmp.error })); return; }
        if (msg.untracked && mode === "worktree") patch = git(root, ["diff", "--no-index", "--", "/dev/null", abs]).out;
        else {
          // 이름이 바뀐 파일은 옛 경로도 함께 넘겨야 git 이 이름 바뀜으로 짝짓는다. 새 경로만 주면 통째로 추가로 나온다.
          const old = msg.oldRel && inRoot(path.resolve(root, String(msg.oldRel))) ? [String(msg.oldRel)] : [];
          patch = git(root, ["diff", "-M", ...cmp.range, "--", ...old, rel]).out;
        }
        ws.send(JSON.stringify({ ...head, patch }));
        return;
      }
      if (msg.untracked) patch = git(root, ["diff", "--no-index", "--", "/dev/null", abs]).out;
      else if (msg.staged) {
        const old = msg.oldRel && inRoot(path.resolve(root, String(msg.oldRel))) ? [String(msg.oldRel)] : [];
        patch = git(root, ["diff", "--staged", "-M", "--", ...old, rel]).out;
      }
      else patch = git(root, ["diff", "--", rel]).out;
      ws.send(JSON.stringify({ type: "git-diff", root, file: abs, staged: !!msg.staged, patch }));
      return;
    }
    // index.lock 이 남은 경우 등 git 이 거절하면 목록만 그대로라 눌러도 반응이 없어 보이므로 거절 문구 전달
    let refused = "";
    const change = (args) => { const r = git(root, args); if (!r.ok && !refused) refused = (r.err || r.out || "git 실행 실패").trim(); };
    if (op === "stage") change(["add", "--", ...safeRels]);
    else if (op === "unstage") change(["restore", "--staged", "--", ...safeRels]);
    else if (op === "stageAll") change(["add", "-A"]);
    else if (op === "discard") {
      if (safeRels.length) change(["restore", "--", ...safeRels]);
      const unt = (msg.untracked || []).map(String).filter((r) => inRoot(path.resolve(root, r)));
      if (unt.length) change(["clean", "-f", "--", ...unt]);
    }
    else if (op === "commit") {
      const m = String(msg.message || "").trim();
      if (!m) { ws.send(JSON.stringify({ type: "git-error", op, root, error: "커밋 메시지를 입력하세요." })); return; }
      const r = git(root, ["commit", "-m", m]);
      ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "커밋됨" } : { type: "git-error", op, root, error: (r.err || r.out || "커밋 실패").trim() }));
    }
    else if (op === "push") { const r = git(root, ["push"], 60000); ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "push 완료" } : { type: "git-error", op, root, error: (r.err || r.out || "push 실패").trim() })); }
    else if (op === "pull") { const r = git(root, ["pull", "--ff-only"], 60000); ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "pull 완료" } : { type: "git-error", op, root, error: (r.err || r.out || "pull 실패").trim() })); }
    else if (op === "checkout") {
      // 로컬 브랜치 목록에 있는 이름만 git 에 넘긴다. 목록 밖 문자열은 옵션이나 커밋으로 해석될 수 있다.
      // 커밋하지 않은 변경과 겹치면 git 이 거절하고, 그 거절을 그대로 알린다(강제 전환·stash 는 하지 않는다).
      const b = String(msg.branch || "");
      if (!gitBranchRefs(root, ["refs/heads"]).includes(b)) { ws.send(JSON.stringify({ type: "git-error", op, root, error: `로컬 브랜치가 없습니다: ${b}` })); return; }
      const r = git(root, ["switch", b]);
      let error = (r.err || r.out || "브랜치 전환 실패").trim();
      // git 은 겹친 파일을 탭으로 들여 쓴 줄로 나열한다. 문구는 사용자 locale 에 따라 달라서 그 줄로만 알아본다.
      const files = r.ok ? [] : error.split("\n").filter((l) => /^\t\S/.test(l)).map((l) => l.trim());
      if (files.length) error = `커밋하지 않은 변경이 ${b} 브랜치와 겹쳐 전환하지 못했습니다. 커밋하거나 되돌린 뒤 다시 하세요. (${files.join(", ")})`;
      ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: `${b} 브랜치로 전환` } : { type: "git-error", op, root, error }));
    }
    if (refused) ws.send(JSON.stringify({ type: "git-error", op, root, error: refused }));
    if (GIT_MUTATIONS.has(op)) { clearGitStatusCache(root); ws.send(JSON.stringify(gitStatusRich(root, dir))); recompute(); } // 조작 후 최신 상태 회신 + 파일트리 git 갱신
  } catch (e) { ws.send(JSON.stringify({ type: "git-error", op, root, error: String(e.message || e) })); }
}

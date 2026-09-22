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
//   Git root 해석, status/diff 파싱, mutation whitelist와 git.* namespace 분기·응답 순서.
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
// 깊이와 개수를 제한한다. 큰 트리에서 이 탐색이 몇 초씩 걸리면 그동안 화면이 비어 있다.
const REPO_SCAN_DEPTH = 4;
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
      // 저장소 안에 다른 저장소가 있을 수 있으므로(서브모듈·모노레포 내 독립 저장소) 계속 탐색한다.
      if (left > 1) walk(abs, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}
function gitCodeOf(c) { return ({ M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U" })[c] || c; }
// reqPath = 화면이 요청한 폴더. 응답에 포함해야 화면이 그 폴더가 어느 저장소로 해석됐는지
// 기억할 수 있다. 중첩 저장소의 .git이 사라지면 같은 폴더가 다른 저장소로 해석되기 때문이다.
function gitStatusRich(root, reqPath) {
  const r = git(root, ["status", "--porcelain=v1", "-uall", "--branch"]);
  const staged = [], changes = []; let branch = "", ahead = 0, behind = 0;
  for (const line of (r.out || "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const b = line.slice(3);
      branch = b.split("...")[0].split(" ")[0] || "";
      const ma = b.match(/ahead (\d+)/); if (ma) ahead = +ma[1];
      const mb = b.match(/behind (\d+)/); if (mb) behind = +mb[1];
      continue;
    }
    const x = line[0], y = line[1]; let rel = line.slice(3);
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop();
    rel = rel.replace(/^"(.*)"$/, "$1");
    const abs = path.join(root, rel);
    if (x === "?" && y === "?") { changes.push({ rel, abs, code: "U", untracked: true }); continue; }
    if (x !== " " && x !== "?") staged.push({ rel, abs, code: gitCodeOf(x) });
    if (y !== " " && y !== "?") changes.push({ rel, abs, code: gitCodeOf(y), untracked: false });
  }
  return { type: "git-status", root, path: reqPath || root, isRepo: true, branch, ahead, behind, staged, changes };
}
const GIT_MUTATIONS = new Set(["stage", "unstage", "stageAll", "discard", "commit", "push", "pull"]);
// 응답에는 항상 어느 저장소의 결과인지 남긴다. 화면이 저장소를 여러 개 동시에 관리해서,
// root가 없으면 성공·실패 알림이 어느 섹션 것인지 붙일 데가 없다. root를 아직 모르는 단계(경로
// 거부)에서는 요청한 폴더(path)를 대신 실어 그 후보를 지울 수 있게 한다.
export function handleGit(ws, msg) {
  const op = msg.type.slice(4); // "git." 뒤
  const dir = msg.path || msg.root;
  if (!dir || !fsPathAllowed(dir)) { ws.send(JSON.stringify({ type: "git-error", op, path: dir || "", error: "허용되지 않은 경로" })); return; }
  // 하위 저장소 찾기. 이 op 는 그 폴더가 저장소가 아니어도 응답해야 하므로 아래 gitRoot 판정보다 앞에
  // 둔다. 스페이스 폴더 자체는 저장소가 아니고 그 안에 저장소가 여럿인 경우가 흔하다.
  if (op === "repos") { ws.send(JSON.stringify({ type: "git-repos", path: dir, repos: nestedRepos(dir) })); return; }
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
    if (op === "diff") {
      const abs = msg.file;
      if (!abs || !inRoot(abs)) { ws.send(JSON.stringify({ type: "git-diff", root, file: abs || "", error: "허용되지 않은 경로" })); return; }
      const rel = path.relative(root, path.resolve(abs));
      let patch = "";
      if (msg.untracked) patch = git(root, ["diff", "--no-index", "--", "/dev/null", abs]).out;
      else if (msg.staged) patch = git(root, ["diff", "--staged", "--", rel]).out;
      else patch = git(root, ["diff", "--", rel]).out;
      ws.send(JSON.stringify({ type: "git-diff", root, file: abs, staged: !!msg.staged, patch }));
      return;
    }
    if (op === "stage") git(root, ["add", "--", ...safeRels]);
    else if (op === "unstage") git(root, ["restore", "--staged", "--", ...safeRels]);
    else if (op === "stageAll") git(root, ["add", "-A"]);
    else if (op === "discard") {
      if (safeRels.length) git(root, ["restore", "--", ...safeRels]);
      const unt = (msg.untracked || []).map(String).filter((r) => inRoot(path.resolve(root, r)));
      if (unt.length) git(root, ["clean", "-f", "--", ...unt]);
    }
    else if (op === "commit") {
      const m = String(msg.message || "").trim();
      if (!m) { ws.send(JSON.stringify({ type: "git-error", op, root, error: "커밋 메시지를 입력하세요." })); return; }
      const r = git(root, ["commit", "-m", m]);
      ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "커밋됨" } : { type: "git-error", op, root, error: (r.err || r.out || "커밋 실패").trim() }));
    }
    else if (op === "push") { const r = git(root, ["push"], 60000); ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "push 완료" } : { type: "git-error", op, root, error: (r.err || r.out || "push 실패").trim() })); }
    else if (op === "pull") { const r = git(root, ["pull", "--ff-only"], 60000); ws.send(JSON.stringify(r.ok ? { type: "git-ok", op, root, message: "pull 완료" } : { type: "git-error", op, root, error: (r.err || r.out || "pull 실패").trim() })); }
    if (GIT_MUTATIONS.has(op)) { clearGitStatusCache(root); ws.send(JSON.stringify(gitStatusRich(root, dir))); recompute(); } // 조작 후 최신 상태 회신 + 파일트리 git 갱신
  } catch (e) { ws.send(JSON.stringify({ type: "git-error", op, root, error: String(e.message || e) })); }
}

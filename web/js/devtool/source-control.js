// 소스 제어: 열린 스페이스와 pane의 git repo를 모아 stage·commit·push/pull·브랜치 전환을 한다.
//
// 소유 범위
//   scRepos/scRootOf/scDead/scAsked/scMsg/scFold/scDirFold와 렌더 지문·알림 타이머, 브랜치 선택기.
//   무엇을 볼지의 경계: 지금 머무는 스페이스 하나와 그 안쪽 폴더들.
//   source-control DOM 렌더·입력/클릭 연결과 git-status/ok/error 메시지 적용.
//
// 제공 API
//   initSourceControl(deps): DOM·전송·workspace/session 조회와 diff 열기 콜백을 받는다.
//   scRoot(), scSync(), scRefresh(), scRefreshFor(file), scRepoName(root): main의 기존 호출부용 API.
//   handleSourceControlMessage(message): 소스 제어 메시지를 처리했으면 true를 돌려준다.
//
// 의존 대상
//   $, esc, wsSend, 현재 agent/space 목록과 spaceRootFor 를 init 에서 주입받는다.
//   diff 는 이 기능에 속하므로 devtool/diff.js 를 직접 import 한다. 앱 셸을 거치지 않는다.
//   main이나 diff를 import하지 않는다. center tab과 session/space 상태는 아직 main이 소유한다.
//
// 유지 조건
//   후보 폴더를 경로 접두사로 repo라고 짐작하지 않고 서버가 돌려준 root로만 합친다.
//   state가 반복돼도 지문이 같으면 다시 그리지 않고, 쓰던 commit 글·커서와 접힘 상태를 보존한다.
//   모든 git op는 화면이 알고 있던 expectRoot를 싣고, discard는 확인을 거친다.
//
// 영향 범위
//   main의 space/state/file-save/WebSocket 호출부, devtool/diff.js의 repo 이름·openDiff 계약,
//   서버의 git.status·git.* 응답 모양.

import { provide } from "../core/hooks.js";
import { repoNameOf } from "../core/repo-name.js";
import { registerTabView } from "../core/tab-views.js";
import { handleGitDiffMessage, initDiff, openDiff as openDiffTab, renderDiffView } from "./diff.js";
import { getActiveTabId, getCenterSpace, getTabs } from "../center/tab-store.js";
import { createDropdown } from "../core/dropdown.js";
import { icon } from "../core/glyphs.js";

// 이 기능의 영역. index.html 이 이 마크업을 항상 그리면 기능을 꺼도
// 셸이 파싱되므로 여기서 만든다. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
// 받기·보내기·브랜치 선택은 지금 보는 레포(목록 맨 위) 하나에 적용된다.
export const panelHtml = `
  <div class="sc-head">
    <span class="sc-title">소스 제어</span>
    <span class="sc-sum" id="sc-sum"></span>
    <button class="sc-ico" id="sc-pull" title="받기 (pull)" aria-label="받기" disabled>${icon("arrowDown", 13)}</button>
    <button class="sc-ico" id="sc-push" title="보내기 (push)" aria-label="보내기" disabled>${icon("arrowUp", 13)}</button>
    <button class="sc-ico" id="sc-refresh" title="전체 새로고침" aria-label="전체 새로고침">${icon("reload", 13)}</button>
  </div>
  <div class="sc-branch-row" id="sc-branch-row" hidden>
    <span class="sc-branch-repo" id="sc-branch-repo"></span>
    <span class="sc-branch-dd" id="sc-branch-dd"></span>
    <span class="sc-sync" id="sc-sync"></span>
  </div>
  <div class="sc-views" id="sc-views" role="tablist" aria-label="변경 보기">
    <button class="sc-view" data-view="local" role="tab" title="커밋하지 않은 변경 (스테이지·작업 트리)">커밋 전</button>
    <button class="sc-view" data-view="base" role="tab" title="Base 브랜치와 갈라진 뒤 커밋된 변경 (base...HEAD)">Base 대비</button>
    <button class="sc-view" data-view="baseWork" role="tab" title="Base 브랜치와 갈라진 뒤의 모든 변경 (커밋 전 변경 포함)">Base+커밋 전</button>
  </div>
  <div class="sc-note" id="sc-note"></div>
  <div class="sc-body" id="sc-body"><div class="sc-empty">스페이스를 선택하세요.</div></div>
`;

let scRepos = new Map();   // root → git-status (레포당 하나)
let scRootOf = new Map();  // 물어본 폴더 → 그 폴더가 풀린 root. 폴더가 다른 레포로 풀리면 갈아탄다
let scDead = new Set();    // repo가 아니거나 접근이 막힌 후보 폴더. 목록에서 제외한다
let scAsked = new Set();   // 이미 물어본 폴더: 스페이스가 열릴 때마다 전부 다시 묻지 않기 위해
let scMsg = new Map();     // root → 쓰다 만 커밋 메시지(재렌더에도 살아남는다)
let scFold = new Set();    // 사용자가 접어 둔 root (기본은 펼침)
let scNested = new Map();  // 스페이스 폴더 → 그 아래에서 서버가 찾아 준 레포 폴더들
let scScanned = new Set(); // 이미 훑어 달라고 부탁한 폴더: 4초마다 다시 훑지 않게
let scBranch = new Map();  // root → git-branch-diff 응답(Base 대비 보기의 파일 목록)
// 보기: local = 커밋 전(status), base = Base 대비 커밋된 것, baseWork = Base 대비 작업 트리까지.
// 보기와 레포별 Base 선택은 이 창을 쓰는 사람의 편의 설정이라 localStorage 에 둔다. 못 읽어도 기본값으로 동작한다.
const SC_VIEWS = ["local", "base", "baseWork"];
const SC_VIEW_KEY = "iris.sc.view", SC_BASE_KEY = "iris.sc.base";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let scView = SC_VIEWS.includes(lsGet(SC_VIEW_KEY)) ? lsGet(SC_VIEW_KEY) : "local";
let scBase = new Map(Object.entries((() => { try { return JSON.parse(lsGet(SC_BASE_KEY) || "{}") || {}; } catch { return {}; } })()));
// 접어 둔 폴더 묶음(root·목록 종류·폴더). 4초마다 다시 그려도, 창을 다시 열어도 접힌 채로 남는다.
// 없어진 폴더의 키가 쌓이지 않게 오래된 것부터 버린다.
const SC_DIRFOLD_KEY = "iris.sc.dirFold", SC_DIRFOLD_MAX = 300;
let scDirFold = new Set((() => { try { const a = JSON.parse(lsGet(SC_DIRFOLD_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })());
let scDd = null;           // 머리 줄 아래 브랜치 선택기(한 벌을 만들어 두고 값만 바꾼다)
let scDdSig = "";
let scBaseDd = new Map(); // root → Base 선택기
let scTarget = null;       // 받기·보내기·브랜치 선택이 적용되는 레포 root
let scVer = 0;             // 화면이 달라질 일이 생길 때마다 올린다(state가 4초마다 와도 불필요한 재렌더를 막는다)
let scSig = "";            // 마지막으로 그린 화면의 지문
let scNoteTimer = null;
let scSelKey = null;       // 선택 표시를 마지막으로 칠한 diff 탭. 같으면 다시 칠하지 않는다
let $ = null;
let esc = null;
let wsSend = null;
let getCurrentAgent = null;
let spaceRootFor = null;
let getSelectedSpaceId = null;
let getSpaces = null;
let getLastAgents = null;
let openDiff = null;

export function initSourceControl(deps) {
  $ = deps.$;
  esc = deps.esc;
  wsSend = deps.wsSend;
  getCurrentAgent = deps.getCurrentAgent;
  spaceRootFor = deps.spaceRootFor;
  getSelectedSpaceId = deps.getSelectedSpaceId;
  getSpaces = deps.getSpaces;
  getLastAgents = deps.getLastAgents;
  openDiff = deps.openDiff;
  const refresh = $("#sc-refresh");
  if (refresh) refresh.onclick = () => { scDead.clear(); scRefresh(); }; // 막혔다고 지워둔 후보도 다시 본다
  const pull = $("#sc-pull"), push = $("#sc-push");
  if (pull) pull.onclick = () => { if (!scTarget) return; scNote(scRepoName(scTarget) + ": 받는 중…"); scOp("pull", scTarget); };
  if (push) push.onclick = () => { if (!scTarget) return; scNote(scRepoName(scTarget) + ": 보내는 중…"); scOp("push", scTarget); };
  const ddBox = $("#sc-branch-dd");
  if (ddBox) {
    scDd = createDropdown({
      items: [], value: "", ariaLabel: "브랜치 전환", className: "sc-sel",
      onChange: (v) => {
        const root = scTarget, st = root ? scRepos.get(root) : null;
        if (!st) return;
        // 선택기에는 서버가 확인한 브랜치만 둔다. 전환이 끝나면 뒤따르는 status 가 새 값을 준다.
        scDd.setValue(st.branch || "");
        if (v === st.branch) return;
        scNote(`${scRepoName(root)}: ${v} 브랜치로 전환 중…`);
        scOp("checkout", root, { branch: v });
      },
    });
    ddBox.appendChild(scDd.el);
  }
  const views = $("#sc-views");
  if (views) {
    views.addEventListener("click", (e) => {
      const b = e.target.closest(".sc-view"); if (!b || b.dataset.view === scView) return;
      scView = b.dataset.view; lsSet(SC_VIEW_KEY, scView);
      scBranch.clear(); // 다른 mode 의 목록이 잠깐이라도 보이면 어느 보기인지 헷갈린다
      scPaintViews(); scVer++; scAskBranchAll(); renderSc();
    });
    scPaintViews();
  }
  const body = $("#sc-body");
  // 조작은 전부 자기 섹션의 레포에만 적용된다. 대상 레포는 클릭한 위치로 결정된다.
  const scCommit = (root) => {
    const m = (scMsg.get(root) || "").trim();
    if (!m) { scNote(scRepoName(root) + ": 커밋 메시지를 입력하세요.", true); return; }
    scOp("commit", root, { message: m });
  };
  if (body) body.addEventListener("input", (e) => {
    const ta = e.target.closest(".sc-msg"); if (ta) scMsg.set(ta.dataset.root, ta.value);
  });
  if (body) body.addEventListener("keydown", (e) => {
    const fh = e.target.closest(".sc-dir-head");
    if (fh && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); scToggleDir(scRepoOf(fh), fh); return; }
    const ta = e.target.closest(".sc-msg"); if (!ta) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); scMsg.set(ta.dataset.root, ta.value); scCommit(ta.dataset.root); }
  });
  if (body) body.addEventListener("click", (e) => {
    const root = scRepoOf(e.target); if (!root) return;
    const st = scRepos.get(root);
    const ract = e.target.closest("[data-ract]");
    if (ract) {
      const a = ract.dataset.ract;
      if (a === "stageAll") scOp("stageAll", root);
      else if (a === "commit") scCommit(root);
      return;
    }
    const gact = e.target.closest(".sc-gact");
    if (gact) {
      const g = gact.dataset.gact;
      if (g === "stageall") scOp("stageAll", root);
      else if (g === "unstageall") scOp("unstage", root, { paths: ((st && st.staged) || []).map((f) => f.rel) });
      return;
    }
    const fh = e.target.closest(".sc-dir-head");
    if (fh) { scToggleDir(root, fh); return; }
    const row = e.target.closest(".sc-file");
    if (!row) {
      // 머리글 아무 곳이나 누르면 접힌다. 레포가 여럿일 때 보지 않는 것을 접어 둘 수 있어야 한다.
      if (e.target.closest(".sc-repo-head")) { if (scFold.has(root)) scFold.delete(root); else scFold.add(root); scVer++; renderSc(); }
      return;
    }
    const rel = row.dataset.rel, abs = row.dataset.abs, staged = row.dataset.staged === "1", untracked = row.dataset.untracked === "1";
    // Base 대비 목록의 파일은 그 목록을 만든 기준(base·mode)으로 연다. 조작 버튼은 없다.
    if (row.dataset.mode) {
      openDiff(abs, { root, rel, untracked, mode: row.dataset.mode, base: row.dataset.base, oldRel: row.dataset.old || "" });
      return;
    }
    const act = e.target.closest(".sc-act");
    if (act) {
      const a = act.dataset.act;
      if (a === "stage") scOp("stage", root, { paths: [rel] });
      else if (a === "unstage") scOp("unstage", root, { paths: [rel] });
      else if (a === "discard") { if (confirm(`${scRepoName(root)}의 변경을 되돌릴까요? 복구할 수 없습니다:\n${rel}`)) scOp("discard", root, untracked ? { untracked: [rel] } : { paths: [rel] }); }
      return;
    }
    openDiff(abs, { staged, untracked, root, rel });
  });
}

// 지금 보고 있는 위치. 화면이 붙어 있는 pane의 cwd가 가장 정확하고, 그것을 모를 때만 스페이스 대표
// 폴더로 내려간다(스페이스의 첫 pane이라 다른 레포를 가리킬 수 있다).
export function scRoot() {
  const a = getCurrentAgent();
  if (a && a.cwd) return a.cwd;
  return spaceRootFor(getSelectedSpaceId()) || spaceRootFor(getCenterSpace()) || null;
}
// 지금 머무는 위치 하나를 정한다. 화면에 무엇을 표시할지가 이 값으로 결정된다.
function scCurrentSpaceId() {
  const a = getCurrentAgent();
  if (a && a.workspaceId) return a.workspaceId;
  return getSelectedSpaceId() || getCenterSpace() || null;
}
// 어느 폴더가 그 폴더 안쪽인지 판정한다. 접두사만 보면 `/a/bc` 가 `/a/b` 안으로 나오므로 경계에 / 를 붙인다.
export function scUnder(root, dir) {
  if (!root || !dir) return false;
  if (dir === root) return true;
  return dir.startsWith(root.endsWith("/") ? root : root + "/");
}
// 볼 폴더 후보: 지금 머무는 스페이스의 폴더와, 그 안쪽에 있는 pane 들의 cwd. 한 스페이스 안에서도
// pane마다 다른 레포에 있을 수 있어 둘을 합집합으로 잡는다(중복은 서버가 준 root에서 합쳐진다).
// 열린 스페이스를 전부 조회하면 다른 스페이스의 레포까지 표시되어, 지금 작업하는 곳을
// 찾기 어려워진다.
// 스페이스 폴더 밖으로 나간 pane 은 "하위"가 아니므로 뺀다.
// 여기서 repo 여부로는 걸러내지 않는다. repo가 아닌 폴더도 목록에 남겨야 사라진 것과 구분해 정리할 수 있다.
export function scCandidatesOf(spaceId, spaces, lastAgents, rootOfSpace, nested) {
  if (!spaceId) return [];
  const s = (spaces || []).find((x) => x && x.id === spaceId) || null;
  const root = (s && s.folder) || rootOfSpace || null;
  const label = (s && s.label) || "";
  const list = [], seen = new Set();
  const push = (dir) => {
    if (!dir || seen.has(dir)) return;
    if (root && !scUnder(root, dir)) return;
    seen.add(dir);
    list.push({ dir, sp: spaceId, labels: label ? [label] : [] });
  };
  push(root);
  // pane 을 띄운 적 없는 하위 레포도 보여야 한다. 스페이스 안에 레포가 여럿이면 그중
  // 하나만 보인다. 목록은 서버가 폴더를 탐색해 만든다.
  for (const d of (nested || [])) push(d);
  for (const a of (lastAgents || [])) if (a && a.workspaceId === spaceId) push(a.cwd);
  return list;
}
function scCandidates() {
  const spaceId = scCurrentSpaceId();
  const spaces = getSpaces();
  const sp = (spaces || []).find((x) => x && x.id === spaceId) || null;
  const root = (sp && sp.folder) || spaceRootFor(spaceId) || null;
  // 폴더 하나당 한 번만 요청한다. state 는 4초마다 오는데 그때마다 트리를 탐색하면 비용이 크다.
  if (root && !scScanned.has(root)) { scScanned.add(root); wsSend({ type: "git.repos", path: root }); }
  return scCandidatesOf(spaceId, spaces, getLastAgents(), root, root ? scNested.get(root) : null);
}
// 스페이스가 열리고 닫히는 것을 따라간다. 새로 생긴 폴더만 물어보고, 없어진 폴더가 남긴 기억은
// 지운다. state는 자주 오므로 전부 다시 묻는 것은 서버에서 git을 동기로 실행하는 만큼 비싸다.
// 살아 있는 레포 = 지금 후보 폴더가 "실제로 풀린" root들. 폴더가 어느 레포로 풀렸는지는 서버가
// 응답에 되돌려준 값(scRootOf)으로만 판단한다. 경로 접두사로 추정하면 중첩 레포의 .git이
// 사라져 그 폴더가 부모로 풀린 뒤에도 없어진 중첩 root가 살아 있는 것처럼 보인다.
function scLiveRoots(cands) {
  const live = new Set();
  for (const c of cands) { const r = scRootOf.get(c.dir); if (r && scRepos.has(r)) live.add(r); }
  return live;
}
export function scSync() {
  if (!document.body.classList.contains("sc-active")) return;
  const cands = scCandidates(), dirs = new Set(cands.map((c) => c.dir));
  for (const d of [...scDead]) if (!dirs.has(d)) scDead.delete(d);     // 다시 열리면 다시 물어본다
  for (const d of [...scAsked]) if (!dirs.has(d)) scAsked.delete(d);
  for (const d of [...scRootOf.keys()]) if (!dirs.has(d)) scRootOf.delete(d);
  // 사라진 레포의 상태는 버린다(다시 열리면 새로 묻는다). 접힘 상태와 작성 중인 메시지는 남긴다.
  // 스페이스를 잠깐 닫았다 여는 동안 작성 중이던 글까지 지우면 손실이 크다.
  const live = scLiveRoots(cands);
  for (const root of [...scRepos.keys()]) if (!live.has(root)) { scRepos.delete(root); scBranch.delete(root); scVer++; }
  let asked = 0;
  for (const c of cands) if (!scDead.has(c.dir) && !scAsked.has(c.dir)) { scAsked.add(c.dir); wsSend({ type: "git.status", path: c.dir }); asked++; }
  // state는 4초마다 온다. 화면이 달라질 일이 없으면 다시 그리지 않는다. 통째로 교체하면
  // 버튼에 있던 키보드 포커스가 사라지고, 변경 1000개짜리 목록을 4초마다 새로 만들게 된다.
  const sig = [...dirs].join("|") + "#" + scVer + "#" + (scRoot() || "");
  if (sig !== scSig || asked) renderSc();
  else scPaintSel(); // 탭을 바꾸거나 닫아도 이 모듈은 알림을 받지 않으므로 state 가 올 때 맞춘다
}
// 전체 새로고침: 캐시를 비우고 처음부터 다시 묻는다(막혔던 폴더·새로 git init한 폴더 포함).
export function scRefresh() {
  scAsked.clear(); scDead.clear(); scScanned.clear(); scNested.clear();
  const cands = scCandidates();
  for (const c of cands) { scAsked.add(c.dir); wsSend({ type: "git.status", path: c.dir }); }
  renderSc(); // 응답 전에도 현재 아는 것은 그대로 표시한다(깜빡임 방지)
}
// 파일 하나가 저장됐을 때: 그 파일이 든 레포만 다시 묻는다. 레포가 여럿인데 전부 물으면
// 저장할 때마다 서버가 git status를 레포 수만큼 동기로 돈다(변경 1000개짜리 레포가 섞이면 체감된다).
export function scRefreshFor(file) {
  if (!file || !document.body.classList.contains("sc-active")) return;
  let hit = null;
  for (const root of scRepos.keys()) if ((file === root || file.startsWith(root + "/")) && (!hit || root.length > hit.length)) hit = root;
  if (hit) wsSend({ type: "git.status", path: hit }); else scSync(); // 모르는 곳이면 후보부터 다시 본다
}
// done = 서버가 끝났다고 답한 결과. 진행 중 안내(…중)와 구분해 확인 표시를 붙인다.
function scNote(msg, err, done) {
  const el = $("#sc-note"); if (!el) return;
  el.innerHTML = msg ? (done ? icon("check", 12) : "") + `<span>${esc(msg)}</span>` : "";
  el.title = msg || ""; // git 오류는 여러 줄이라 세 줄까지만 보이고 전문은 여기 남긴다
  el.classList.toggle("err", !!err); el.classList.toggle("ok", !!done && !err);
  clearTimeout(scNoteTimer);
  if (msg) scNoteTimer = setTimeout(() => { el.textContent = ""; el.title = ""; el.classList.remove("err", "ok"); }, 6000);
}
function scDirKey(root, fold) { return root + "\n" + fold; }
// 폴더 묶음 하나를 접거나 편다. 목록 전체를 다시 그리지 않고 그 머리와 몸통만 바꾼다.
function scToggleDir(root, head) {
  if (!root || !head) return;
  const key = scDirKey(root, head.dataset.fold || "");
  const shut = !scDirFold.has(key);
  if (shut) scDirFold.add(key); else scDirFold.delete(key);
  while (scDirFold.size > SC_DIRFOLD_MAX) scDirFold.delete(scDirFold.values().next().value);
  lsSet(SC_DIRFOLD_KEY, JSON.stringify([...scDirFold]));
  head.classList.toggle("open", !shut);
  head.setAttribute("aria-expanded", shut ? "false" : "true");
  const bodyEl = head.nextElementSibling;
  if (bodyEl && bodyEl.classList.contains("sc-dir-body")) bodyEl.classList.toggle("collapsed", shut);
}
// 머리 줄의 받기·보내기와 그 아래 브랜치 선택기를 지금 보는 레포에 맞춘다.
function scPaintHead(r, many) {
  scTarget = r ? r.root : null;
  const pull = $("#sc-pull"), push = $("#sc-push"), row = $("#sc-branch-row");
  if (pull) pull.disabled = !r;
  if (push) push.disabled = !r;
  if (!row) return;
  if (!r) { row.hidden = true; scDdSig = ""; return; }
  row.hidden = false;
  const st = r.st, name = scRepoName(r.root), cur = st.branch || "";
  if (pull) pull.title = `${name}: 받기 (pull --ff-only)` + (st.behind ? ` · ${st.behind}개 뒤처짐` : "");
  if (push) push.title = `${name}: 보내기 (push)` + (st.ahead ? ` · ${st.ahead}개 앞섬` : "");
  // 레포가 여럿이면 선택기가 어느 레포의 것인지 이름을 붙인다.
  const repoEl = $("#sc-branch-repo"); if (repoEl) { repoEl.textContent = many ? name : ""; repoEl.hidden = !many; }
  const sync = $("#sc-sync");
  if (sync) sync.textContent = (st.ahead ? "↑" + st.ahead : "") + (st.ahead && st.behind ? " " : "") + (st.behind ? "↓" + st.behind : "");
  if (!scDd) return;
  const names = Array.isArray(st.branches) ? st.branches.slice() : [];
  if (cur && !names.includes(cur)) names.unshift(cur); // 분리된 HEAD 처럼 목록에 없는 현재 위치도 보여 준다
  const sig = r.root + "\n" + cur + "\n" + names.join("\n");
  if (sig === scDdSig) return;
  scDdSig = sig;
  // 값을 먼저 바꾼다. 닫힌 목록은 setItems 때만 다시 그려지므로 순서가 바뀌면 선택 표시가 이전 브랜치에 남는다.
  scDd.setValue(cur);
  scDd.setItems(names.map((n) => ({ value: n, label: n })));
  scDd.el.querySelector(".cc-dd-trigger")?.setAttribute("aria-label", `${name} 브랜치 전환`);
}
export function scRepoName(root) { return repoNameOf(root); }
// 코어가 이 모듈을 import 하지 않고도 부를 수 있게 이름을 등록한다. 깃을 끈 사용자에게는
// 이 훅이 비어 있고, 부르는 쪽은 그대로 동작한다.
provide("git.sync", () => { scSync(); scRefreshFor(scRoot()); });
provide("git.syncOnly", () => scSync());
provide("git.refreshFor", (dir) => scRefreshFor(dir));
// 보기 이름 → 서버 mode. local 은 status 를 쓰므로 mode 가 없다.
const scModeOf = (v) => (v === "base" ? "committed" : v === "baseWork" ? "worktree" : "");
function scPaintViews() {
  for (const b of document.querySelectorAll("#sc-views .sc-view")) {
    const on = b.dataset.view === scView;
    b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false");
  }
}
// Base 대비 목록 요청. base 가 비어 있으면 서버가 기본 브랜치를 골라 응답에 적어 준다.
function scAskBranch(root) {
  const mode = scModeOf(scView); if (!mode || !root) return;
  wsSend({ type: "git.branchDiff", path: root, base: scBase.get(root) || "", mode });
}
function scAskBranchAll() { for (const root of scRepos.keys()) scAskBranch(root); }
// expectRoot = 화면이 "이 레포에 한다"고 알고 있던 것. 서버가 그 사이 다른 레포로 풀리면 거절한다.
function scOp(op, root, extra) {
  if (!root) { scNote("레포를 찾지 못했습니다.", true); return; }
  wsSend(Object.assign({ type: "git." + op, path: root, expectRoot: root }, extra || {}));
}
// 서버 응답 반영. status는 root로 키를 잡아 합치고, repo가 아닌 후보는 목록에서 지운다.
function scOnStatus(m) {
  const dir = m.path || m.root;
  const was = scRootOf.get(dir);
  if (m.isRepo === false) { scDead.add(dir); scRootOf.delete(dir); }
  else { scRootOf.set(dir, m.root); scRepos.set(m.root, m); }
  // 그 폴더가 전에 다른 레포로 풀려 있었다면, 후보가 남지 않은 이전 레포는 화면에서 뺀다.
  if (was && was !== m.root && ![...scRootOf.values()].includes(was)) { scRepos.delete(was); scBranch.delete(was); }
  // status 가 다시 온 때가 곧 그 레포가 바뀌었을 수 있는 때다(저장·커밋·새로고침). Base 보기도 함께 갱신한다.
  if (m.isRepo !== false) scAskBranch(m.root);
  scVer++;
  renderSc();
}
function scOnBranchDiff(m) {
  // 보기를 바꾼 뒤 늦게 도착한 이전 mode 의 응답은 버린다.
  if (!m.root || m.mode !== scModeOf(scView) || !scRepos.has(m.root)) return;
  scBranch.set(m.root, m);
  scVer++;
  renderSc();
}
// 가운데에서 보고 있는 diff 의 파일 줄을 선택으로 칠한다. 같은 파일도 스테이지 여부·Base 보기에 따라
// 다른 탭이므로 탭을 연 조건이 모두 같은 줄만 칠한다.
function scActiveDiff() {
  const sp = getCenterSpace(); if (!sp) return null;
  const t = getTabs(sp).find((x) => x.id === getActiveTabId(sp));
  return t && t.kind === "diff" ? t : null;
}
function scPaintSel(force) {
  const body = $ && $("#sc-body"); if (!body) return;
  const t = scActiveDiff(), key = t ? t.id : "";
  if (!force && key === scSelKey) return;
  scSelKey = key;
  for (const row of body.querySelectorAll(".sc-file")) {
    const mode = row.dataset.mode || "";
    const on = !!t && t.root === scRepoOf(row) && t.rel === row.dataset.rel && (t.mode || "") === mode
      && (mode ? (t.base || "") === (row.dataset.base || "") : !!t.staged === (row.dataset.staged === "1"));
    row.classList.toggle("on", on);
  }
}
function scRepoOf(el) { const box = el && el.closest(".sc-repo"); return box ? box.dataset.root : null; }
// Base 대비 보기의 비교 기준 선택기. 다시 그릴 때마다 새로 만들면 열려 있던 목록이 닫히므로
// 레포마다 한 벌을 두고 새 자리로 옮긴다. 화면에서 빠진 레포의 것은 버린다.
function scMountBaseDd(body) {
  const seen = new Set();
  for (const slot of body.querySelectorAll(".sc-base-slot")) {
    const root = scRepoOf(slot), br = root ? scBranch.get(root) : null; if (!br) continue;
    seen.add(root);
    const bases = br.bases || [];
    const items = bases.map((b) => ({ value: b, label: b }));
    if (br.base && !bases.includes(br.base)) items.unshift({ value: br.base, label: br.base + " (없음)" });
    let dd = scBaseDd.get(root);
    if (!dd) {
      dd = createDropdown({ items: [], value: "", ariaLabel: `${scRepoName(root)} 비교할 Base 브랜치`, className: "sc-sel", onChange: (v) => {
        scBase.set(root, v); lsSet(SC_BASE_KEY, JSON.stringify(Object.fromEntries(scBase)));
        scAskBranch(root);
      } });
      scBaseDd.set(root, dd);
    }
    dd.setValue(br.base || "");
    dd.setItems(items.length ? items : [{ value: "", label: "(브랜치 없음)" }]);
    slot.appendChild(dd.el);
  }
  for (const [root, dd] of scBaseDd) if (!seen.has(root)) { dd.destroy(); scBaseDd.delete(root); }
}
function renderSc() {
  const branch = $("#sc-sum"), body = $("#sc-body");
  if (!body) return;
  const cands = scCandidates();
  // 지금 화면에 있는 레포 = 후보 폴더가 실제로 풀린 레포(서버가 되돌려준 값). 스페이스가 닫히면
  // 그 폴더가 빠지고, 마지막 폴더가 빠진 레포는 저절로 목록에서 사라진다.
  const cur = scRoot(), curRoot = cur ? scRootOf.get(cur) : null;
  const rows = [], byRoot = new Map();
  cands.forEach((c, i) => {
    const root = scRootOf.get(c.dir); if (!root || !scRepos.has(root)) return;
    let row = byRoot.get(root);
    if (!row) { row = { root, st: scRepos.get(root), labels: [], order: i, isCur: root === curRoot }; byRoot.set(root, row); rows.push(row); }
    for (const l of c.labels) if (!row.labels.includes(l)) row.labels.push(l);
  });
  rows.sort((a, b) => (b.isCur - a.isCur) || (a.order - b.order)); // 지금 보고 있는 레포가 맨 위
  const sig = cands.map((c) => c.dir).join("|") + "#" + scVer + "#" + (cur || ""); // 방금 그린 화면의 지문
  if (!rows.length) {
    if (branch) branch.textContent = "";
    scPaintHead(null, false);
    body.innerHTML = `<div class="sc-empty">${cands.length ? "git 저장소가 없습니다." : "스페이스를 선택하세요."}</div>`;
    scSig = sig;
    return;
  }
  const many = rows.length > 1;
  scPaintHead(rows[0], many);
  // 레포 하나의 변경 수. 지금 보기 기준으로 센다(Base 보기에서 커밋 전 개수를 적으면 목록과 어긋난다).
  const countOf = (r) => scView === "local"
    ? (r.st.staged || []).length + (r.st.changes || []).length
    : ((scBranch.get(r.root) || {}).files || []).length;
  // 머리글 요약: 레포가 여럿일 때만 몇 개가 얼마나 밀려 있는지를 적는다. 레포가 하나면 브랜치는 아래 선택기가 보여 준다.
  if (branch) {
    if (many) {
      const n = rows.reduce((a, r) => a + countOf(r), 0);
      const dirty = rows.filter((r) => countOf(r)).length;
      branch.textContent = n ? `레포 ${rows.length} · ${dirty}곳 ${n}개 변경` : `레포 ${rows.length} · 변경 없음`;
    } else branch.textContent = "";
  }
  const caret = icon("chevronRight", 10);
  // 파일을 폴더별로 묶는다. 폴더 머리에 그 폴더의 파일 수를 적고, 폴더 이름은 머리가 들고 있으므로 줄에는 파일 이름만 둔다.
  // kind 는 같은 폴더가 스테이지·변경 두 목록에 함께 있을 때 접힘을 따로 기억하기 위한 것이다.
  const grouped = (root, kind, files, rowFn) => {
    const by = new Map();
    for (const f of files) {
      const rel = f.rel || f.abs || "", i = rel.lastIndexOf("/"), d = i >= 0 ? rel.slice(0, i) : "";
      if (!by.has(d)) by.set(d, []);
      by.get(d).push(f);
    }
    const dirs = [...by.keys()].sort((a, b) => (a === b ? 0 : a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1)); // 루트 파일이 먼저
    return `<div class="sc-files">` + dirs.map((d) => {
      const fold = kind + "|" + d, shut = scDirFold.has(scDirKey(root, fold)), label = d || "(루트)";
      return `<div class="sc-dir-head${shut ? "" : " open"}" role="button" tabindex="0" aria-expanded="${shut ? "false" : "true"}" data-fold="${esc(fold)}" title="${esc(label)}">`
        + caret + `<span class="sc-dir-name">${esc(label)}</span><span class="sc-dir-n">${by.get(d).length}</span></div>`
        + `<div class="sc-dir-body${shut ? " collapsed" : ""}">${by.get(d).map(rowFn).join("")}</div>`;
    }).join("") + `</div>`;
  };
  const nameOf = (rel) => { const slash = rel.lastIndexOf("/"); return slash >= 0 ? rel.slice(slash + 1) : rel; };
  const fileRow = (f, staged) => {
    const rel = f.rel || f.abs;
    const acts = staged
      ? `<button class="sc-act" data-act="unstage" title="언스테이지" aria-label="언스테이지">${icon("minus", 13)}</button>`
      : `<button class="sc-act" data-act="stage" title="스테이지" aria-label="스테이지">${icon("plus", 13)}</button>`
        + `<button class="sc-act" data-act="discard" title="변경 취소" aria-label="변경 취소">${icon("undo", 13)}</button>`;
    return `<div class="sc-file ${esc(f.code)}" title="${esc(rel)}" data-abs="${esc(f.abs)}" data-rel="${esc(rel)}" data-staged="${staged ? 1 : 0}" data-untracked="${f.untracked ? 1 : 0}">`
      + `<span class="sc-code ${esc(f.code)}">${esc(f.code)}</span>`
      + `<span class="sc-name">${esc(nameOf(rel))}</span>`
      + `<span class="sc-actions">${acts}</span></div>`;
  };
  // Base 대비 목록의 파일 줄. 이 목록은 비교 결과라 스테이지·되돌리기 버튼을 두지 않는다.
  const branchRow = (f, br) => {
    const rel = f.rel || f.abs;
    const tip = f.oldRel ? `${f.oldRel} → ${rel}` : rel;
    return `<div class="sc-file ${esc(f.code)}" title="${esc(tip)}" data-abs="${esc(f.abs)}" data-rel="${esc(rel)}" data-untracked="${f.untracked ? 1 : 0}"`
      + ` data-mode="${esc(br.mode)}" data-base="${esc(br.base)}" data-old="${esc(f.oldRel || "")}">`
      + `<span class="sc-code ${esc(f.code)}">${esc(f.code)}</span>`
      + `<span class="sc-name">${esc(nameOf(rel))}</span>`
      + `</div>`;
  };
  const branchInner = (root) => {
    const br = scBranch.get(root);
    if (!br) return `<div class="sc-repo-clean">불러오는 중…</div>`;
    // 선택기는 그린 뒤 이 자리에 붙인다(scMountBaseDd). 레포마다 한 벌을 만들어 두고 다시 쓴다.
    let html = `<div class="sc-base-row"><span class="sc-base-lbl">Base</span><span class="sc-base-slot"></span></div>`;
    if (br.error) return html + `<div class="sc-repo-clean err">${esc(br.error)}</div>`;
    const files = br.files || [];
    if (!files.length) return html + `<div class="sc-repo-clean">${esc(br.base)} 대비 달라진 파일이 없습니다.</div>`;
    html += `<div class="sc-group-head">${br.mode === "worktree" ? "커밋 전 포함 변경" : "커밋된 변경"}<span class="sc-count">${files.length}</span></div>`;
    return html + grouped(root, "branch", files, (f) => branchRow(f, br));
  };
  const section = (r) => {
    const st = r.st, folded = many && scFold.has(r.root);
    const staged = st.staged || [], changes = st.changes || [], n = countOf(r);
    const name = scRepoName(r.root);
    const where = r.labels.filter((l) => l !== name).join(" · ");
    const ah = (st.ahead ? "↑" + st.ahead : "") + (st.ahead && st.behind ? " " : "") + (st.behind ? "↓" + st.behind : "");
    let inner = "";
    if (scView !== "local") inner = branchInner(r.root);
    // 변경이 없어도 작성 중인 커밋 메시지가 있으면 입력란을 남긴다. 마지막 변경을 되돌린 순간
    // 입력란이 사라지면 작성 중이던 글도 사라진 것으로 보인다.
    else if (n || (scMsg.get(r.root) || "").trim()) {
      inner += `<div class="sc-commit">`
        + `<textarea class="sc-msg" data-root="${esc(r.root)}" rows="3" placeholder="${esc(name)}에 커밋 (⌘Enter)"></textarea>`
        + `<div class="sc-commit-row"><button class="sc-btn" data-ract="stageAll" title="모든 변경을 스테이지">${icon("plus", 13)}모두 스테이지</button>`
        + `<span class="sc-hint">⌘Enter</span>`
        + `<button class="sc-btn sc-btn-pri" data-ract="commit" title="스테이지된 변경을 커밋">${icon("check", 13)}커밋`
        + (staged.length ? `<span class="sc-commit-n">${staged.length}</span>` : "") + `</button></div></div>`;
      if (staged.length) {
        inner += `<div class="sc-group-head">스테이지된 변경<span class="sc-count">${staged.length}</span><button class="sc-gact" data-gact="unstageall" title="모두 언스테이지" aria-label="모두 언스테이지">${icon("minus", 13)}</button></div>`;
        inner += grouped(r.root, "staged", staged, (f) => fileRow(f, true));
      }
      if (changes.length) {
        inner += `<div class="sc-group-head">변경<span class="sc-count">${changes.length}</span><button class="sc-gact" data-gact="stageall" title="모두 스테이지" aria-label="모두 스테이지">${icon("plus", 13)}</button></div>`;
        inner += grouped(r.root, "changes", changes, (f) => fileRow(f, false));
      }
    } else inner = `<div class="sc-repo-clean">변경사항이 없습니다.</div>`;
    // 레포가 하나면 머리 줄과 선택기가 그 레포를 가리키므로 레포 머리를 두지 않는다.
    // 여럿이면 어느 레포의 목록인지 알리는 한 줄 머리를 둔다(누르면 접힌다).
    const head = !many ? "" : `<div class="sc-repo-top"><div class="sc-repo-head" title="${esc(r.root)}">`
      + caret.replace("<svg ", '<svg class="sc-fold" ')
      + `<span class="sc-repo-name">${esc(name)}</span>`
      + (where ? `<span class="sc-repo-where">${esc(where)}</span>` : "")
      + icon("branch", 12).replace("<svg ", '<svg class="sc-repo-bi" ')
      + `<span class="sc-repo-branch">${esc(st.branch || "?")}</span>`
      + (ah ? `<span class="sc-repo-ahead">${ah}</span>` : "")
      + `<span class="sc-repo-n${n ? "" : " zero"}">${n}</span>`
      + `</div></div>`;
    return `<div class="sc-repo${folded ? " folded" : ""}${r.isCur ? " cur" : ""}${many ? "" : " solo"}" data-root="${esc(r.root)}">`
      + head + `<div class="sc-repo-body">${inner}</div></div>`;
  };
  // 커밋 메시지는 sc-body 안에 있어 재렌더에 지워진다. 저장·스페이스 전환이 갱신을 부르므로
  // 작성 중이던 글과 커서 위치를 복원한다.
  const ae = document.activeElement;
  const keep = ae && ae.classList && ae.classList.contains("sc-msg")
    ? { root: ae.dataset.root, s: ae.selectionStart, e: ae.selectionEnd } : null;
  body.innerHTML = rows.map(section).join("");
  scMountBaseDd(body);
  for (const ta of body.querySelectorAll(".sc-msg")) {
    ta.value = scMsg.get(ta.dataset.root) || "";
    if (keep && keep.root === ta.dataset.root) { ta.focus(); try { ta.setSelectionRange(keep.s, keep.e); } catch (e) {} }
  }
  scPaintSel(true);
  scSig = sig;
}

export function handleSourceControlMessage(m) {
  if (m.type === "git-repos") {
    // 찾아 준 폴더를 후보에 추가하고 곧바로 상태를 묻는다. scSync 는 새 후보만 물으므로 중복은 없다.
    scNested.set(m.path, Array.isArray(m.repos) ? m.repos : []);
    scVer++;
    scSync();
    return true;
  }
  if (m.type === "git-status") {
    scOnStatus(m);
  } else if (m.type === "git-branch-diff") {
    scOnBranchDiff(m);
  } else if (m.type === "git-ok") {
    if (m.op === "commit" && m.root) { scMsg.delete(m.root); for (const el of document.querySelectorAll(".sc-msg")) if (el.dataset.root === m.root) el.value = ""; }
    scNote((m.root ? scRepoName(m.root) + ": " : "") + (m.message || "완료"), false, true);
  } else if (m.type === "git-error") {
    // 후보 폴더가 막혀 있으면(심링크·경계 밖) 목록에서 뺀다. 반복 알림은
    // 사용자가 조치할 수 없고 다른 레포 알림을 가린다.
    if (m.op === "status") { if (m.path) { scDead.add(m.path); renderSc(); } }
    else scNote((m.root ? scRepoName(m.root) + ": " : "") + (m.error || "오류"), true);
  } else return false;
  return true;
}

// 이 기능의 연결. 표에는 선언만 남고, 연결 방법은 각 기능이 소유한다.
export function initCapability(ctx) {
  // diff 화면은 이 기능에 속하므로 여기서 함께 연결한다. 끄면 화면도 탭도 없다.
  initDiff({
    $: ctx.$, esc: ctx.esc, wsSend: ctx.wsSend,
    getSelectedSpaceId: ctx.getSelectedSpaceId,
    renderTabs: ctx.renderTabs, showActiveTab: ctx.showActiveTab,
    ensureMonacoLib: ctx.ensureMonacoLib, monacoTheme: ctx.monacoTheme,
  });
  registerTabView({ kind: "diff", panelId: "diffview", render: (t) => { renderDiffView(t); scPaintSel(); } });
  initSourceControl({
    $: ctx.$, esc: ctx.esc, wsSend: ctx.wsSend,
    getCurrentAgent: ctx.getCurrentAgent,
    spaceRootFor: ctx.spaceRootFor,
    getSelectedSpaceId: ctx.getSelectedSpaceId,
    getSpaces: ctx.getSpaces,
    getLastAgents: ctx.getLastAgents,
    openDiff: openDiffTab,
  });
  const on = handleSourceControlMessage;
  return {
    screen: { enter: scRefresh },
    ws: {
      "git-repos": on, "git-status": on, "git-branch-diff": on, "git-ok": on, "git-error": on,
      "git-diff": handleGitDiffMessage,
    },
  };
}

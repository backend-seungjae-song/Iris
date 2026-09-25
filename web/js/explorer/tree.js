// 포커스 스페이스의 파일 트리와 Spaces · Agents 목록을 렌더하고 파일 reveal을 이어 간다.
//
// 소유 범위
//   Explorer DOM 참조·클릭 배선, 트리 포커스, 생성 뒤 포커스 예약, 비동기 reveal 상태와
//   파일별 git 상태·아이콘 표현.
//
// 제공 API
//   initTree, 트리·Spaces 렌더와 디렉터리 요청/무효화, Explorer DOM 접근자, 에이전트 줄 등록(registerSpaceAgents),
//   생성 포커스·git 상태 갱신, reveal 시작·취소·fs 응답 처리, 펼친 디렉터리 목록과 extOf.
//
// 의존 대상
//   파일 열기·팔레트 root·탭 상태는 center 도메인 모듈에서 import 한다. $·esc·wsSend와
//   Spaces 정렬·접힘 저장·watch 동기화는 main 에서 받고, collapsed·dirCache는 안정된 참조,
//   selectedSpaceId·activeFile은 호출 시점 접근자와 setter로 받는다.
//
// 유지 조건
//   fs.list의 loading 캐시와 exact expectedDir/token 재검증 순서, root containment guard,
//   생성·reveal의 가운데 스크롤, 폴더 토글 뒤 접힘 저장→렌더→watch 순서를 보존한다.
//
// 영향 범위
//   main 의 초기화·Space 포커스·파일 탭 reveal·fs/fs-op WebSocket 배선과 watch 디렉터리 수집,
//   explorer/context-menu 의 DOM·캐시 무효화·재요청·렌더 import 계약, center/text-editor 의 extOf.
//   현재 목록 확인: node bin/importers.mjs web/js/explorer/tree.js

import { spaceRootFor } from "../center/file-palette.js";
import { openFile } from "../center/file-routing.js";
import { getActiveTabId, getCenterSpace, getTabs } from "../center/tab-store.js";
import { STATE_LABEL, spaceState } from "../core/agent-state.js";
import { getLastAgents } from "../herdr/state.js";

let $, esc, wsSend, orderedSpaces, getIsLocal, getSelectedSpaceId;
let getActiveFile, setActiveFile, saveCollapsed, syncWatchDirs;
let collapsed, dirCache;
let spaceList, fileTree, explorerSpace, fileAdd, folderAdd;
let treeFocusPath = null;
let pendingCreateFocus = null;
let pendingReveal = null;
let revealTokenSeq = 0;
const gitStatus = {}; // 절대경로 → git 상태 문자(M/A/U/D). 백엔드 fs.list가 채움.

// 트리 줄의 선 아이콘. 접기 삼각형은 열리면 CSS 가 돌린다.
const SVG_TOG = '<svg class="i caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const SVG_DIR = '<svg class="i ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_FILE = '<svg class="i ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const SVG_GRIP = '<svg class="i grip" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/></svg>';
export const extOf = (n) => { const i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1).toLowerCase() : ""; };

export function initTree(deps) {
  ({ $, esc, wsSend, orderedSpaces, getIsLocal, getSelectedSpaceId,
    getActiveFile, setActiveFile, saveCollapsed, syncWatchDirs, collapsed, dirCache } = deps);
  spaceList = $("#space-list"); fileTree = $("#file-tree"); explorerSpace = $("#explorer-space");
  fileAdd = $("#file-add"); folderAdd = $("#folder-add");

  // Explorer 트리 클릭: 파일 열기 / 폴더 토글
  fileTree.addEventListener("click", (e) => {
    const file = e.target.closest(".fitem.file");
    if (file) { treeFocusPath = file.dataset.file; openFile(file.dataset.file); return; }
    const dir = e.target.closest(".fitem.dir");
    if (dir) { const p = dir.dataset.dir; treeFocusPath = p; if (dirCache.has(p) && !collapsed.dirs.has(p)) collapsed.dirs.add(p); else { collapsed.dirs.delete(p); requestDir(p); } saveCollapsed(); renderFileTree(); syncWatchDirs(); }
  });
}

export function getSpaceList() { return spaceList; }
export function getFileTree() { return fileTree; }
export function invalidateDir(dir) { dirCache.delete(dir); }
export function setPendingCreateFocus(value) { pendingCreateFocus = value; }
export function mergeGitStatus(status) { Object.assign(gitStatus, status); }

function renderDir(dirPath, depth) {
  const entries = dirCache.get(dirPath), pad = depth * 12 + 8;
  if (entries === "loading" || entries === undefined) return `<div class="floading" style="padding-left:${pad}px">…</div>`;
  if (!entries.length) return `<div class="fempty" style="padding-left:${pad}px">(비어 있음)</div>`;
  return `<ul class="ftree">` + entries.map((e) => {
    if (e.dir) {
      const open = !collapsed.dirs.has(e.path) && dirCache.has(e.path);
      return `<li><div class="fitem dir${treeFocusPath === e.path ? " focused" : ""}" data-dir="${esc(e.path)}" style="padding-left:${pad}px">${open ? SVG_TOG.replace('class="i caret"', 'class="i caret open"') : SVG_TOG}${SVG_DIR}<span class="fname">${esc(e.name)}</span></div>${open ? renderDir(e.path, depth + 1) : ""}</li>`;
    }
    const g = gitStatus[e.path];
    return `<li><div class="fitem file${getActiveFile() === e.path ? " active" : ""}${treeFocusPath === e.path ? " focused" : ""}${g ? " git-" + g : ""}" data-file="${esc(e.path)}" style="padding-left:${pad + 14}px">${SVG_FILE}<span class="fname">${esc(e.name)}</span>${g ? `<span class="gbadge">${g}</span>` : ""}</div></li>`;
  }).join("") + `</ul>`;
}

// Explorer: 포커스된 스페이스의 루트 트리를 그린다(스페이스마다 각각의 작업공간).
export function renderFileTree() {
  const s = orderedSpaces().find((x) => x.id === getSelectedSpaceId());
  fileAdd.hidden = !getIsLocal() || !s || !s.folder;
  folderAdd.hidden = !getIsLocal() || !s || !s.folder;
  if (!s || !s.folder) { fileTree.innerHTML = `<div class="fempty">스페이스를 선택하면 파일 트리가 열립니다.</div>`; explorerSpace.textContent = "스페이스 선택"; return; }
  explorerSpace.textContent = s.label;
  fileTree.innerHTML = renderDir(s.folder, 0);
}

// 스페이스 줄마다 바로 아래에 그 스페이스의 에이전트 줄을 끼운다. 에이전트 줄은 herdr/agents 가
// 등록한 함수가 만들고, 등록한 쪽이 없으면 스페이스 줄만 남는다. herdr 는 앱 셸이라 이름 훅
// (core/hooks.js, 기능만 채운다) 대신 context-menu 의 registerAgentRenderer 와 같은 등록으로 잇는다.
// rows(spaceId) → { count, open, html }, hold() → 참이면 지금 다시 그리지 않는다.
let spaceAgents = null;
export function registerSpaceAgents(provider) { spaceAgents = provider; }

export function renderSpaces() {
  // 에이전트 이름을 제자리에서 고치는 중이면 다시 그리지 않는다. 그리면 입력칸이 사라진다.
  if (spaceAgents && spaceAgents.hold()) return;
  const list = orderedSpaces();
  // 스페이스 생성은 셸을 만드는 작업이라 로컬에서만 가능하다(AC5). 원격에서는 버튼을 두지 않는다.
  const addBtn = $("#space-add"); if (addBtn) addBtn.hidden = !getIsLocal();
  if (!list.length) { spaceList.innerHTML = `<div class="fempty">Space 없음</div>`; return; }
  spaceList.innerHTML = list.map((s) => {
    const sel = s.id === getSelectedSpaceId();
    const st = spaceState(s.status, getLastAgents(), s.id);
    const ag = spaceAgents ? spaceAgents.rows(s.id) : null;
    const count = (ag && ag.count) || 0;
    const open = !!(ag && ag.open);
    const tog = count
      ? `<button class="space-tog${open ? " open" : ""}" type="button" data-space-tog="${esc(s.id)}" aria-expanded="${open}" title="에이전트 ${open ? "접기" : "펼치기"}">${SVG_TOG.replace(" caret", "")}</button>`
      : `<span class="space-tog-spacer" aria-hidden="true"></span>`;
    return `<div class="space-row${sel ? " sel" : ""}" draggable="true" data-space="${esc(s.id)}" data-folder="${esc(s.folder || "")}">`
      + `${SVG_GRIP}${tog}<span class="space-name">${esc(s.label)}</span>`
      + (!open && count ? `<span class="space-count" title="접힌 에이전트">${count}</span>` : "")
      + (sel ? `<span class="kbd" title="스페이스 이동">⌥⇧↑↓</span>` : "")
      + `<span class="dot ${st}" role="img" aria-label="${STATE_LABEL[st]}" title="${STATE_LABEL[st]}"></span></div>`
      + ((ag && ag.html) || "");
  }).join("");
}

export function requestDir(p) { if (p && !dirCache.has(p)) { dirCache.set(p, "loading"); wsSend({ type: "fs.list", path: p }); } }
function normalizeRevealPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
function isRevealPathWithinRoot(root, targetPath) {
  return !!root && !!targetPath && targetPath !== root
    && targetPath.startsWith(root === "/" ? "/" : root + "/");
}
function revealAncestorDirs(root, targetPath) {
  const parent = targetPath.slice(0, targetPath.lastIndexOf("/")) || "/";
  const dirs = [root];
  if (parent === root) return dirs;
  const rel = parent.slice(root === "/" ? 1 : root.length + 1);
  let dir = root;
  for (const part of rel.split("/")) {
    if (!part) continue;
    dir = dir === "/" ? "/" + part : dir + "/" + part;
    dirs.push(dir);
  }
  return dirs;
}
function isPendingRevealCurrent(p) {
  if (!p || p !== pendingReveal || p.token !== revealTokenSeq) return false;
  if (getSelectedSpaceId() !== p.space || getCenterSpace() !== p.space || getActiveTabId(p.space) !== p.tabId) return false;
  const tab = getTabs(p.space).find((x) => x.id === p.tabId);
  if (!tab || tab.kind !== "file" || tab.path !== p.targetPath) return false;
  if (normalizeRevealPath(spaceRootFor(p.space)) !== p.root) return false;
  return isRevealPathWithinRoot(p.root, p.targetPath);
}
export function cancelPendingReveal() {
  if (pendingReveal && pendingReveal.token === revealTokenSeq) ++revealTokenSeq;
}
function continuePendingReveal(p) {
  if (!isPendingRevealCurrent(p)) { if (pendingReveal === p) pendingReveal = null; return; }
  let collapseChanged = false;
  const dirs = revealAncestorDirs(p.root, p.targetPath);
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const entries = dirCache.get(dir);
    if (entries === undefined || entries === "loading") {
      if (collapseChanged) saveCollapsed();
      p.expectedDir = dir;
      requestDir(dir);
      return;
    }
    if (!Array.isArray(entries)) { pendingReveal = null; return; }
    const nextPath = i + 1 < dirs.length ? dirs[i + 1] : p.targetPath;
    const child = entries.find((entry) => entry && entry.path === nextPath
      && (nextPath === p.targetPath ? !entry.dir : !!entry.dir));
    if (!child) { pendingReveal = null; return; }
    if (collapsed.dirs.delete(dir)) collapseChanged = true;
  }
  if (collapseChanged) saveCollapsed();
  p.expectedDir = null;
  treeFocusPath = p.targetPath;
  renderFileTree();
  const target = fileTree.querySelector(`.fitem.file[data-file="${CSS.escape(p.targetPath)}"]`);
  pendingReveal = null;
  if (!target) return;
  fileTree.querySelectorAll(".fitem.file.active").forEach((el) => el.classList.remove("active"));
  setActiveFile(p.targetPath);
  target.classList.add("active");
  // file-tree는 세로 크기를 드래그로 바꿀 수 있다(#file-tree.panel-body, overflow-y:auto).
  // block:"center"는 호출 시점의 실제 컨테이너 높이를 기준으로 계산되므로 크기를 바꿔도
  // 따로 계산할 필요 없이 그 시점 기준 가운데로 맞는다.
  target.scrollIntoView({ block: "center" });
  syncWatchDirs();
}
export function startPendingReveal(t) {
  const centerSpace = getCenterSpace();
  const root = normalizeRevealPath(spaceRootFor(centerSpace));
  const targetPath = normalizeRevealPath(t && t.path);
  if (centerSpace !== getSelectedSpaceId() || !t || t.kind !== "file" || !t.path
    || getActiveTabId(centerSpace) !== t.id || !root || !targetPath
    || !isRevealPathWithinRoot(root, targetPath)) return;
  pendingReveal = {
    space: centerSpace,
    tabId: t.id,
    targetPath: targetPath,
    root: root,
    expectedDir: null,
    token: ++revealTokenSeq,
  };
  continuePendingReveal(pendingReveal);
}
export function handlePendingRevealFs(m) {
  const p = pendingReveal;
  if (!p || m.path !== p.expectedDir) return false;
  if (!isPendingRevealCurrent(p)) { pendingReveal = null; return true; }
  if (m.error) { pendingReveal = null; return true; }
  dirCache.set(m.path, m.entries || []);
  syncWatchDirs();
  if (m.git) Object.assign(gitStatus, m.git);
  p.expectedDir = null;
  continuePendingReveal(p);
  return true;
}
export function focusCreatedAfterList(dirPath) {
  const p = pendingCreateFocus;
  if (!p || p.parent !== dirPath) return;
  pendingCreateFocus = null;
  treeFocusPath = p.path;
  renderFileTree();
  const selector = p.isDir
    ? `.fitem.dir[data-dir="${CSS.escape(p.path)}"]`
    : `.fitem.file[data-file="${CSS.escape(p.path)}"]`;
  const target = fileTree.querySelector(selector);
  if (target) target.scrollIntoView({ block: "center" });
}

// 지금 트리에서 내용을 보고 있는 폴더 = 이미 목록을 받았고 접혀 있지 않은 것. 감시 대상이다.
export function expandedDirs() {
  const out = [];
  for (const p of dirCache.keys()) if (dirCache.get(p) !== "loading" && !collapsed.dirs.has(p)) out.push(p);
  return out;
}

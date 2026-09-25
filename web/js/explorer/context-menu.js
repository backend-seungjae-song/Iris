// Explorer 파일·스페이스 컨텍스트 메뉴와 이름 입력 대화상자.
//
// 소유 범위
//   파일 클립보드, 컨텍스트 메뉴 DOM·표시 상태, 입력 대화상자, Space 드래그 상태와
//   파일/폴더 생성·이름변경·복사·이동·삭제 및 Space 생성·보관·닫기 연결.
//
// 제공 API
//   initContextMenu, 파일/공용 메뉴 표시, 입력·확인 대화상자, 메뉴 닫기,
//   Space 보관 항목과 생성 뒤 포커스 예약 상태의 접근자·setter.
//
// 의존 대상
//   tab-store·tab-close 는 같은 center 도메인 모듈에서 import 한다.
//   $·esc·wsSend·toast/clipboard와 현재 로컬 여부·선택 Space는 main 이 소유해 init 에서 받는다.
//   Agents 상태는 herdr/state에서, Explorer DOM·캐시 갱신은 explorer/tree 에서 import 한다.
//   Agents 재렌더는 herdr/agents가 registerAgentRenderer로 등록한다.
//
// 유지 조건
//   selectedSpaceId·isLocal·lastAgents 는 호출 때마다 접근자로 읽고, fs.op 전송 모양과
//   삭제 전 dirty/identity 재검증 순서, capture keydown 및 전역 listener 등록 순서를 보존한다.
//
// 영향 범위
//   main 의 초기화·WebSocket Space 포커스 예약·IPC 메뉴 닫기 배선, center/tab-close 의
//   파일 탭 메뉴 재사용, browser/tabs·sheet/actions·sheet/events·docx/editor 초기화에서 받는
//   showCtx/askText/askConfirm/askInfo API, explorer/tree 의 DOM·캐시·렌더와 우클릭 등록 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/explorer/context-menu.js

import { callHook } from "../core/hooks.js";
import { createItems } from "../panel/herdr-tabs.js";
import {
  chooseDirtyAction, hasActiveCloseDialog, isTabDirty, removeTabsNow, saveTabForClose,
} from "../center/tab-close.js";
import { getTabs, getTabSpaces } from "../center/tab-store.js";
import {
  getFileTree, getSpaceList, invalidateDir, renderFileTree, renderSpaces, requestDir,
} from "./tree.js";
import { getLastAgents } from "../herdr/state.js";

let $, esc, wsSend, showToast, copyText, isFileLikeKind;
let getIsLocal, getSelectedSpaceId, orderedSpaces, saveOrder;
let focusSpace;
let renderAgents = () => {};
let ctxmenu;
let fileClip = null; // { path, mode: 'cut'|'copy' }
let dragId = null;
let pendingSpaceFocus = null;   // 생성 응답이 목록 갱신보다 먼저 오므로, 들어올 때까지 들고 있는다

export function initContextMenu(deps) {
  ({ $, esc, wsSend, showToast, copyText, isFileLikeKind,
    getIsLocal, getSelectedSpaceId, orderedSpaces, saveOrder, focusSpace } = deps);
  ctxmenu = $("#ctxmenu");
  wireContextMenu();
}

export function registerAgentRenderer(renderer) { renderAgents = renderer; }
// 스페이스 줄을 눌렀을 때 그 아래 에이전트 줄을 접고 펴는 것은 접힘 상태를 가진 herdr/agents 가 한다.
// 포커스 이동이 접힌 그룹을 펴므로, 누르기 전 상태를 알고 포커스를 옮긴 뒤 뒤집어야 한다.
let spaceRowClick = null;
export function registerSpaceRowClick(fn) { spaceRowClick = fn; }

function spaceRoot() {
  const s = orderedSpaces().find((x) => x.id === getSelectedSpaceId());
  return s && s.folder ? s.folder : null;
}

function relPath(abs) {
  const r = spaceRoot();
  if (r && (abs === r || abs.startsWith(r + "/"))) return abs.slice(r.length + 1) || abs.split("/").pop();
  return abs.split("/").pop();
}

// 스페이스 하나에 할 수 있는 조작. Agents 판의 그룹 머리글도 같은 스페이스를 가리키므로
// 같은 항목을 쓴다. 두 곳의 항목이 다르면 어느 쪽이 정본인지 알 수 없다.
export function spaceCtxItems(id) {
  const s = orderedSpaces().find((x) => x.id === id);
  const name = s ? s.label : id;
  return [
    { label: "이 스페이스로 이동", act: () => focusSpace(id) },
    ...(getIsLocal() ? createItems(id) : []),
    { sep: true },
    { label: "폴더 경로 복사", disabled: !s?.folder, act: () => { copyText(s.folder).then((ok) => showToast(ok ? "경로를 복사했습니다" : "경로를 복사하지 못했습니다")); } },
    callHook("archive.spaceItem", id, name),
    { sep: true },
    { label: "이 스페이스 닫기", danger: true, disabled: !getIsLocal(), act: () => {
      const n = (getLastAgents() || []).filter((a) => a.workspaceId === id).length;
      const warn = n ? `\n이 스페이스의 에이전트 ${n}개가 함께 종료됩니다.` : "";
      if (!confirm(`스페이스 "${name}"을(를) 닫을까요?${warn}\n되돌릴 수 없습니다.`)) return;
      wsSend({ type: "space.close", workspaceId: id });
    } },
  ];
}

export function hideCtxMenu() { ctxmenu.hidden = true; ctxmenu.innerHTML = ""; }

async function createFsEntry(destDir, kind) {
  if (!getIsLocal()) { showToast("원격에서는 파일이나 폴더를 만들 수 없습니다"); return; }
  if (!destDir) { showToast("먼저 스페이스를 선택하세요"); return; }
  const isFile = kind === "file";
  const name = await askText(isFile ? "새 파일" : "새 폴더", "", `${relPath(destDir)} 안에 만듭니다`);
  if (name === null) return;
  if (!name.trim()) { showToast("이름을 입력하세요"); return; }
  wsSend({ type: "fs.op", op: kind === "file" ? "create-file" : "create-dir", destDir, name: name.trim() });
}

function createEntryMenuItems(destDir) {
  const isLocal = getIsLocal();
  return [
    { label: "새 파일", disabled: !isLocal, act: isLocal ? () => createFsEntry(destDir, "file") : null },
    { label: "새 폴더", disabled: !isLocal, act: isLocal ? () => createFsEntry(destDir, "dir") : null },
  ];
}

// extra: 부르는 쪽이 덧붙일 항목(탭바에서 부를 때의 닫기 계열). 메뉴 본체는 한 곳에만 둔다.
// 트리와 탭바가 각자 메뉴를 만들면 한쪽만 오래된 상태로 남는다.
export function openFileCtx(x, y, absPath, isDir, extra) {
  const destDir = isDir ? absPath : absPath.slice(0, absPath.lastIndexOf("/"));
  const normalizeLexicalPath = (value) => {
    const parts = [];
    for (const part of String(value || "").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop(); else parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const isPathWithin = (rootPath, childPath) => {
    const root = normalizeLexicalPath(rootPath), child = normalizeLexicalPath(childPath);
    return child === root || child.startsWith(root === "/" ? "/" : root + "/");
  };
  const filePathIdentity = async (pathValue) => {
    try { return await window.acHost?.filePathIdentity(pathValue); }
    catch (error) { return { ok: false, missing: true, error: String(error && error.message || error) }; }
  };
  const samePathIdentity = (before, after) => !!(before && after && before.ok && after.ok
    && before.dev === after.dev && before.ino === after.ino
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && before.size === after.size && before.canonicalPath === after.canonicalPath);
  const collectAffectedTabs = async (rootPath) => {
    const normalizedRootPath = normalizeLexicalPath(rootPath);
    const rootIdentity = await filePathIdentity(rootPath);
    const canonicalRoot = rootIdentity && rootIdentity.ok ? rootIdentity.canonicalPath : null;
    const affectedTabs = [];
    for (const space of getTabSpaces()) {
      for (const tabRef of getTabs(space)) {
        if (!isFileLikeKind(tabRef.kind) || !tabRef.path) continue;
        const normalizedTabPath = normalizeLexicalPath(tabRef.path);
        let affected = isPathWithin(normalizedRootPath, normalizedTabPath);
        if (!affected && canonicalRoot) {
          const tabIdentity = await filePathIdentity(tabRef.path);
          const canonicalPath = tabIdentity && tabIdentity.ok ? tabIdentity.canonicalPath : null;
          affected = !!(canonicalPath && isPathWithin(canonicalRoot, canonicalPath));
        }
        if (affected) affectedTabs.push({ space, tabId: tabRef.id, tabRef });
      }
    }
    return affectedTabs;
  };
  const items = [];
  items.push(...createEntryMenuItems(destDir));
  items.push({ sep: true });
  items.push({ label: "Finder에서 보기", act: () => window.acHost?.revealInFinder(absPath) });
  items.push({ sep: true });
  items.push({ label: "상대 경로 복사", act: () => { copyText(relPath(absPath)).then((ok) => showToast(ok ? "상대 경로 복사됨" : "상대 경로를 복사하지 못했습니다")); } });
  items.push({ label: "경로 복사", act: () => { copyText(absPath).then((ok) => showToast(ok ? "경로 복사됨" : "경로를 복사하지 못했습니다")); } });
  items.push({ sep: true });
  items.push({ label: "잘라내기", act: () => { fileClip = { path: absPath, mode: "cut" }; showToast("잘라내기: " + relPath(absPath)); } });
  items.push({ label: "복사", act: () => { fileClip = { path: absPath, mode: "copy" }; showToast("복사: " + relPath(absPath)); } });
  items.push({ label: "붙여넣기", disabled: !fileClip, act: () => {
    if (!fileClip) return;
    wsSend({ type: "fs.op", op: fileClip.mode === "cut" ? "move" : "copy", src: fileClip.path, destDir });
    fileClip = null;
  } });
  items.push({ sep: true });
  items.push({ label: "이름 변경", act: async () => {
    const cur = absPath.split("/").pop();
    const name = await askText("새 이름", cur, relPath(absPath));
    if (name && name.trim() && name.trim() !== cur) wsSend({ type: "fs.op", op: "rename", path: absPath, name: name.trim() });
  } });
  items.push({ label: "삭제(휴지통)", danger: true, act: async () => {
    if (hasActiveCloseDialog()) return showToast("다른 저장 확인이 진행 중입니다");
    const initialIdentity = await filePathIdentity(absPath);
    if (!initialIdentity || !initialIdentity.ok) { showToast("삭제 중단: 대상 파일을 확인할 수 없습니다"); return; }
    const initialAffectedTabs = await collectAffectedTabs(absPath);
    const initialDirtyTabs = initialAffectedTabs.filter((target) => isTabDirty(target.tabRef));
    let choice = "discard";
    if (initialDirtyTabs.length) {
      if (hasActiveCloseDialog()) return showToast("다른 저장 확인이 진행 중입니다");
      choice = await chooseDirtyAction("삭제 전에 저장할까요?", initialDirtyTabs.map((target) => target.tabRef.label || target.tabRef.path).join("\n"));
      if (choice === "cancel") return;
    } else if (!confirm(`휴지통으로 이동할까요?\n${relPath(absPath)}`)) return;

    const currentIdentity = await filePathIdentity(absPath);
    if (!samePathIdentity(initialIdentity, currentIdentity)) {
      showToast("삭제 중단: 확인하는 동안 대상 파일이 변경되었거나 사라졌습니다");
      return;
    }
    const freshAffectedTabs = await collectAffectedTabs(absPath);
    const freshDirtyTabs = freshAffectedTabs.filter((target) => isTabDirty(target.tabRef));
    const initialRefs = new Set(initialAffectedTabs.map((target) => target.tabRef));
    const initialDirtyRefs = new Set(initialDirtyTabs.map((target) => target.tabRef));
    const affectedSetChanged = freshAffectedTabs.length !== initialRefs.size
      || freshAffectedTabs.some((target) => !initialRefs.has(target.tabRef));
    const dirtySetChanged = freshDirtyTabs.length !== initialDirtyRefs.size
      || freshDirtyTabs.some((target) => !initialDirtyRefs.has(target.tabRef));
    if (affectedSetChanged || dirtySetChanged) {
      showToast("삭제 중단: 확인하는 동안 영향받는 탭이나 미저장 상태가 변경되었습니다");
      return;
    }
    if (choice === "save") {
      const saveResults = await Promise.allSettled(freshDirtyTabs.map((target) => saveTabForClose(target.tabRef, target.space)));
      if (saveResults.some((result) => result.status === "rejected") || freshDirtyTabs.some((target) => isTabDirty(target.tabRef))) {
        showToast("삭제 중단: 저장하지 못한 탭이 남아 있습니다");
        return;
      }
    }
    const res = await window.acHost?.trashItem(absPath);
    if (!res || !res.ok) { showToast("삭제 실패: " + (res && res.error || "알 수 없음")); return; }
    removeTabsNow(freshAffectedTabs);
    const parent = absPath.slice(0, absPath.lastIndexOf("/")); invalidateDir(parent); requestDir(parent); renderFileTree(); showToast("휴지통으로 이동됨");
  } });
  if (Array.isArray(extra)) items.push(...extra);
  showCtx(x, y, items);
}

// 항목 배열을 받아 컨텍스트 메뉴를 띄운다(파일·탭·그룹이 공용).
// 항목 중에는 기능이 채우는 것이 있다. 그 기능을 끄면 채우는 쪽이 없어 빈 값이 온다.
// 거르지 않으면 끈 사용자의 우클릭에서 오류가 난다. 거르는 규칙만 따로 내보내 검사가 직접 부른다.
// DOM 없이 확인할 수 있는 것을 DOM 안에 두면 확인할 방법이 없어진다.
export function ctxItems(raw) { return (Array.isArray(raw) ? raw : []).filter(Boolean); }

export function showCtx(x, y, rawItems) {
  const items = ctxItems(rawItems);
  // 색처럼 선택지가 여섯 개인 항목은 여섯 줄로 늘어놓으면 메뉴가 길어져 찾기
  // 어렵다. 한 줄에 색점으로 배치한다.
  const row = (it, i) => `<div class="ci-sw" data-i="${i}">${it.label ? `<span class="ci-sw-l">${esc(it.label)}</span>` : ""}`
    + it.swatches.map((sw, j) => `<button class="ci-dot${sw.on ? " on" : ""}" data-i="${i}" data-j="${j}"`
      + ` style="--dot:${sw.color || "transparent"}" title="${esc(sw.label)}" aria-label="${esc(sw.label)}"></button>`).join("")
    + `</div>`;
  ctxmenu.innerHTML = items.map((it, i) => it.sep ? `<div class="sep"></div>`
    : it.swatches ? row(it, i)
    : `<div class="ci${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}" data-i="${i}">${esc(it.label)}</div>`).join("");
  ctxmenu.hidden = false;
  // 화면 밖으로 넘치지 않게 위치 보정
  const mw = ctxmenu.offsetWidth, mh = ctxmenu.offsetHeight;
  ctxmenu.style.left = Math.min(x, innerWidth - mw - 6) + "px";
  ctxmenu.style.top = Math.min(y, innerHeight - mh - 6) + "px";
  ctxmenu.querySelectorAll(".ci").forEach((el) => el.addEventListener("click", () => { const it = items[+el.dataset.i]; hideCtxMenu(); if (it && it.act) it.act(); }));
  ctxmenu.querySelectorAll(".ci-dot").forEach((el) => el.addEventListener("click", () => {
    const sw = items[+el.dataset.i]?.swatches?.[+el.dataset.j];
    hideCtxMenu(); if (sw && sw.act) sw.act();
  }));
}

// 이름을 묻는다. window.prompt는 이 런타임에 없다(Electron 렌더러에서 예외를 던진다).
// 프롬프트가 필요한 곳은 전부 이 함수를 쓴다. 취소하면 null.
export function askText(title, def = "", note = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    wrap.innerHTML = `<div class="askbox">
      <div class="asktitle">${esc(title)}</div>
      ${note ? `<div class="asknote">${esc(note)}</div>` : ""}
      <input type="text" />
      <div class="askrow"><button data-a="cancel">취소</button><button class="primary" data-a="ok">확인</button></div>
    </div>`;
    const inp = wrap.querySelector("input");
    inp.value = def;
    let done = false;
    const finish = (v) => { if (done) return; done = true; wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) return finish(null);                       // 바깥 클릭 = 취소
      const b = e.target.closest("button"); if (!b) return;
      finish(b.dataset.a === "ok" ? inp.value : null);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(inp.value); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
      e.stopPropagation();                                              // 전역 단축키가 채가지 않게
    });
    document.body.appendChild(wrap);
    inp.focus(); inp.select();
  });
}

// askText와 같은 이유(window.confirm/alert도 이 Electron 렌더러에서 미지원. 확인 결과: docx 툴바에서
// window.confirm/alert를 쓰면 클릭해도 반응이 없다)로 window.confirm·
// window.alert 호출도 이 두 함수로 온다.
export function askConfirm(title, note = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    wrap.innerHTML = `<div class="askbox">
      <div class="asktitle">${esc(title)}</div>
      ${note ? `<div class="asknote">${esc(note)}</div>` : ""}
      <div class="askrow"><button data-a="cancel">취소</button><button class="primary" data-a="ok">확인</button></div>
    </div>`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) return finish(false);
      const b = e.target.closest("button"); if (!b) return;
      finish(b.dataset.a === "ok");
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    document.body.appendChild(wrap);
    wrap.tabIndex = -1; wrap.focus();
  });
}

export function askInfo(title, note = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    wrap.innerHTML = `<div class="askbox">
      <div class="asktitle">${esc(title)}</div>
      ${note ? `<div class="asknote">${esc(note)}</div>` : ""}
      <div class="askrow"><button class="primary" data-a="ok">확인</button></div>
    </div>`;
    let done = false;
    const finish = () => { if (done) return; done = true; wrap.remove(); resolve(); };
    wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("button")) finish(); });
    wrap.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); finish(); } e.stopPropagation(); });
    document.body.appendChild(wrap);
    wrap.tabIndex = -1; wrap.focus();
  });
}

// 스페이스 보관은 보관 기능에 속한다. 여기서 만들면 보관을 꺼도 조작이 남아, 끈 기능이
// 화면에서만 사라지고 동작은 남는다. 그래서 훅 이름으로 받아 온다. 보관이 꺼져
// 있으면 아무것도 오지 않고, showCtx 가 그 빈 값을 거른다.
export function getPendingSpaceFocus() { return pendingSpaceFocus; }
export function setPendingSpaceFocus(value) { pendingSpaceFocus = value; }

function wireContextMenu() {
  const fileTree = getFileTree(), spaceList = getSpaceList();
  document.addEventListener("click", (e) => { if (!ctxmenu.hidden && !e.target.closest("#ctxmenu")) hideCtxMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ctxmenu.hidden) hideCtxMenu(); }, true);
  window.addEventListener("blur", hideCtxMenu);
  window.addEventListener("resize", hideCtxMenu);
  fileTree.addEventListener("scroll", () => { if (!ctxmenu.hidden) hideCtxMenu(); }); // 고정 메뉴가 다른 행 위에 남지 않게

  $("#file-add")?.addEventListener("click", (e) => { e.stopPropagation(); createFsEntry(spaceRoot(), "file"); });
  $("#folder-add")?.addEventListener("click", (e) => { e.stopPropagation(); createFsEntry(spaceRoot(), "dir"); });

  fileTree.addEventListener("contextmenu", (e) => {
    const file = e.target.closest(".fitem.file"), dir = e.target.closest(".fitem.dir");
    if (!file && !dir) {
      const root = spaceRoot();
      if (!root) return;
      e.preventDefault();
      showCtx(e.clientX, e.clientY, createEntryMenuItems(root));
      return;
    }
    e.preventDefault();
    if (file) openFileCtx(e.clientX, e.clientY, file.dataset.file, false);
    else openFileCtx(e.clientX, e.clientY, dir.dataset.dir, true);
  });
  // Spaces 목록 클릭: 스페이스 포커싱(Explorer·Agents·센터 연동)과 그 에이전트 줄 접기·펴기.
  // 줄 앞 삼각형은 접기만 하고 포커스를 옮기지 않으므로 herdr/agents 가 따로 받는다.
  spaceList.addEventListener("click", (e) => {
    if (e.target.closest("[data-space-tog]")) return;
    const row = e.target.closest(".space-row");
    if (!row) return;
    if (spaceRowClick) spaceRowClick(row.dataset.space, focusSpace);
    else focusSpace(row.dataset.space);
  });

  // ＋ 새 스페이스: herdr와 같게 경로를 직접 지정한다. cwd 없이 만들면 herdr가 호출자(=서버)의 cwd를
  // 물려줘서 Explorer·git·실행이 전부 엉뚱한 폴더를 가리키는 스페이스가 되므로, 폴더는 반드시 받는다.
  // 이름은 여기서 정하지 않는다. herdr가 그 스페이스의 현재 폴더 이름을 붙이고, pane에서 cd 하면
  // 이름도 따라간다. 여기서든 서버에서든 이름을 붙이면 herdr에 고정되어 더는 따라가지 않는다.
  $("#space-add")?.addEventListener("click", (e) => { e.stopPropagation(); newSpace(); });

  // 스페이스 우클릭: 닫기. 그 스페이스의 탭·에이전트가 전부 종료되는 비가역 조작이라 한 번 묻는다.
  // 줄이 아닌 빈 영역에서도 받는다. 목록이 비었거나 아래쪽 빈 영역을 눌렀을 때 아무 일도
  // 일어나지 않으면 기능이 없는 것으로 읽힌다.
  spaceList.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input, textarea")) return;
    // 에이전트 줄은 같은 목록 안에 있지만 메뉴는 그 줄을 그린 쪽이 띄운다.
    if (e.target.closest(".srow, .agent-info-row, .agent-add-row")) return;
    e.preventDefault();
    const row = e.target.closest(".space-row");
    if (!row) {
      showCtx(e.clientX, e.clientY, [
        { label: "새 스페이스", disabled: !getIsLocal(), act: () => newSpace() },
      ]);
      return;
    }
    showCtx(e.clientX, e.clientY, spaceCtxItems(row.dataset.space));
  });
  // 드래그로 Space 순서 변경
  spaceList.addEventListener("dragstart", (e) => { const r = e.target.closest(".space-row"); if (!r) return; dragId = r.dataset.space; r.classList.add("dragging"); });
  // 에이전트 줄 끌기도 같은 목록에서 일어나므로 스페이스를 끄는 중(dragId)일 때만 표시를 만진다.
  spaceList.addEventListener("dragend", (e) => { e.target.closest(".space-row")?.classList.remove("dragging"); spaceList.querySelectorAll(".space-row.dragover").forEach((x) => x.classList.remove("dragover")); dragId = null; });
  spaceList.addEventListener("dragover", (e) => { if (!dragId) return; e.preventDefault(); const r = e.target.closest(".space-row"); spaceList.querySelectorAll(".space-row.dragover").forEach((x) => x.classList.remove("dragover")); if (r && r.dataset.space !== dragId) r.classList.add("dragover"); });
  spaceList.addEventListener("drop", (e) => {
    e.preventDefault();
    const r = e.target.closest(".space-row"); if (!r || !dragId) return;
    const list = orderedSpaces(); const from = list.findIndex((s) => s.id === dragId); const to = list.findIndex((s) => s.id === r.dataset.space);
    if (from < 0 || to < 0) return;
    const [m] = list.splice(from, 1); list.splice(to, 0, m); saveOrder(list); dragId = null; renderSpaces(); renderAgents();
  });
}

async function newSpace() {
  if (!getIsLocal()) return;
  const cwd = await askText("새 스페이스 폴더", spaceRoot() ? spaceRoot() + "/" : "~/", "경로를 입력하세요(~ 로 시작해도 됩니다)");
  if (cwd === null) return;                              // 취소
  const p = cwd.trim();
  if (!p) return;
  wsSend({ type: "space.create", cwd: p });              // 이름은 herdr가 폴더에서 붙이고 계속 따라간다
}

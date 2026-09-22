// 소유 범위: 센터 탭 닫기 확인 대화상자, 닫기/폐기/경로 재지정 흐름, 탭바 닫기 이벤트.
// 주입받는 것: main 소유 DOM·브라우저/Monaco 상태 접근자와 렌더·저장·감시 함수.
// 제공 API: initTabClose, dirty 판정, 닫기·폐기·재지정·시트 모드 전환 함수.
// 의존 대상: sheet 편집/액션 모듈, center/file-routing 정규식과 tab-store command/query.
// 영향 범위: tab-store·fileview·monacoEditor·monacoViewState 및 브라우저 webview 수명주기.

import { bmActiveId, boundSpace, bsMutate, getBrowserState, setBrowserActiveTab } from "../browser/state.js";
import {
  getWebview, removeDiscardedWebview, removeWebview, removeWebviewLastUsed,
  removeWebviewStatus,
} from "../browser/webview-store.js";
import { fileKindOf } from "../core/file-kinds.js";
import { callHook } from "../core/hooks.js";
import { noteClosedCenterTab } from "./closed-tabs.js";
import {
  getActiveTabId, getCenterSpace, getCurrentTabs, getTabs, getTabSpaces,
  removeTab, setActiveTab,
} from "./tab-store.js";

let esc, showToast, fileview, tabstrip, BROWSER_MODE, isFileLikeKind;
let tabIoRegistry, sendTabIo;
let renderTabs, showActiveTab, persistFileTabs, syncWatchDirs;
let trackFileWatch, untrackFileWatch, forgetTabWc;
let renderBmTabs, reconcileDocTabs, scheduleWebviewThrottling;
let openFileCtx, showCtx, startTabRename;
let exportBrowserHistory;
let getMonacoModels, getMonacoViewState, getMonacoEditor, getMonacoRuntime;
let isTextTabDirty, saveFileTab, renderFileView, monacoLangFor, disposeClosedFileModel;
let resetModelTextExternally;
let initialized = false;

// monaco 접근자 넷도 여기서 받는다. 보내는 쪽(text-editor.js initTextEditor)이 넷을 함께 보내므로
// 받는 쪽에서 하나라도 빠뜨리면 그 접근자가 undefined 가 되고, 호출하는 순간 TypeError 가 난다.
// 영향을 받는 곳은 commitDiscardTab(되돌리기 커밋)과 retargetFileTabs(이름 바꾼 파일의 탭
// 재지정) 둘이며, 둘 다 예외를 잡는 곳이 없어 아무 일도 하지 않는 것처럼 보인다.
// initTabClose 의 목록에는 넣지 않는다. main.js 는 이 넷을 갖고 있지 않아 거기서 꺼내면
// undefined 로 덮어쓴다.
export function bindTabCloseTextEditor(deps) {
  ({
    isTextTabDirty, saveFileTab, renderFileView, monacoLangFor, disposeClosedFileModel,
    resetModelTextExternally,
    getMonacoModels, getMonacoViewState, getMonacoEditor, getMonacoRuntime,
  } = deps);
}

export function initTabClose(deps) {
  ({
    esc, showToast, fileview, tabstrip, BROWSER_MODE, isFileLikeKind,
    tabIoRegistry, sendTabIo,
    renderTabs, showActiveTab, persistFileTabs, syncWatchDirs,
    trackFileWatch, untrackFileWatch, forgetTabWc,
    renderBmTabs, reconcileDocTabs, scheduleWebviewThrottling,
    openFileCtx, showCtx, startTabRename,
    exportBrowserHistory,
  } = deps);
  // 텍스트 편집기 몫은 여기서 받지 않는다. main 은 그 이름들을 보내지 않으므로 여기서 꺼내면
  // undefined 로 덮어쓴다. 지금 순서(initTabClose → initTextEditor)에서는 뒤의 바인딩이 다시
  // 채우지만, 순서가 뒤집히면 undefined 가 그대로 남는다.
  // 채우는 곳은 text-editor.js 의 initTextEditor 하나다.
  if (initialized) return;
  initialized = true;
  initTabCloseEvents();
}

// 이 탭에 저장하지 않은 편집이 있는지 판정한다. 앱 셸이 아는 것은 텍스트 편집뿐이고, 나머지는
// 상태를 들고 있는 뷰어가 답한다. 여기서 뷰어의 필드를 직접 읽으면 뷰어를 추가할 때마다
// 이 함수도 함께 고쳐야 한다.
// 뷰어가 로드되지 않았으면 훅이 undefined 를 주며, 이는 들고 있는 상태가 없다는 뜻이다.
export function isTabDirty(t) {
  if (!t) return false;
  return isTextTabDirty(t) || !!callHook("viewer.tabDirty", t);
}
let activeCloseDialog = null;

export function hasActiveCloseDialog() {
  return !!activeCloseDialog;
}

export async function chooseDirtyAction(title, names) {
  if (activeCloseDialog) return null;
  activeCloseDialog = promptDirtyChoice(title, names);
  try { return await activeCloseDialog; }
  finally { activeCloseDialog = null; }
}

function finishCloseDialogChoice(choice, finish) {
  if (choice === "cancel") { finish("cancel"); return; }
  finish(choice);
}
function promptDirtyChoice(title, names) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    const lines = String(names || "").split("\n").filter(Boolean);
    wrap.innerHTML = `<div class="askbox">
      <div class="asktitle">${esc(title)}</div>
      <div class="asknote">${lines.map((name) => esc(name)).join("<br>")}</div>
      <div class="askrow"><button data-act="cancel">취소</button><button data-act="discard">저장 안 함</button><button class="primary" data-act="save">저장</button></div>
    </div>`;
    let done = false;
    const finish = (choice) => { if (done) return; done = true; wrap.remove(); resolve(choice); };
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) { finishCloseDialogChoice("cancel", finish); return; }
      const button = event.target.closest("button[data-act]");
      if (button) finishCloseDialogChoice(button.dataset.act || "cancel", finish);
    });
    document.body.appendChild(wrap);
  });
}
export async function saveTabForClose(t, space) {
  // 인라인 편집기가 없으면 훅이 아무 일도 하지 않으므로, 존재 확인을 위해 여기서 필드를 읽지 않는다.
  callHook("viewer.closeEdit", t, true);
  // 이 탭이 뷰어의 것이면 뷰어가 저장한다. undefined 는 "우리 것이 아니다"라는 답이다.
  const mine = callHook("viewer.saveTab", t, space);
  const pending = mine === undefined ? saveFileTab(t, space) : mine;
  if (pending) await pending;
}
function resolveLiveCloseTargets(targets) {
  const liveTargets = [];
  for (const target of targets || []) {
    const list = getTabs(target.space);
    const current = list.find((tab) => tab === target.ref);
    if (!current) continue;
    if (current === target.ref) liveTargets.push(target);
  }
  return liveTargets;
}
async function captureBrowserHistories(targets) {
  const histories = new Map();
  if (typeof exportBrowserHistory !== "function") return histories;
  await Promise.all((targets || []).map(async (target) => {
    const tab = target && (target.tabRef || target.ref);
    if (!tab || !(String(tab.id).startsWith("browser:") || (BROWSER_MODE && !isFileLikeKind(tab.kind)))) return;
    const webview = getWebview(tab.id);
    if (!webview || !webview.el || typeof webview.el.getWebContentsId !== "function") return;
    try {
      const result = await exportBrowserHistory(webview.el.getWebContentsId());
      if (result && result.ok && result.history) histories.set(String(tab.id), result.history);
    } catch {}
  }));
  return histories;
}

export function removeTabsNow(targets, browserHistories = null) {
  callHook("viewer.closePopups");
  const seen = new Set();
  let changed = false;
  for (const target of targets || []) {
    const tabRef = target && (target.tabRef || target.ref);
    if (!tabRef || seen.has(tabRef)) continue;
    seen.add(tabRef);
    const list = getTabs(target.space);
    const current = list.find((tab) => tab === tabRef);
    if (!current) continue;
    if (target.ref && !(current === target.ref)) continue;
    callHook("viewer.cleanupDocxRender", current);
    callHook("viewer.tearDownTab", current);
    if (isFileLikeKind(current.kind) && current.path) untrackFileWatch(current.path, target.space, current.id);
    const webview = getWebview(current.id);
    if (webview) {
      forgetTabWc(webview, current.id);
      try { webview.el.remove(); } catch {}
      removeWebview(current.id);
    }
    removeDiscardedWebview(current.id); removeWebviewLastUsed(current.id); removeWebviewStatus(current.id);
    if (!removeTab(target.space, current)) continue;
    changed = true;
    if (getActiveTabId(target.space) === current.id) {
      const nextActive = list.length ? list[list.length - 1].id : null;
      setActiveTab(target.space, nextActive);
      // 분리 창은 새 활성 탭을 browser state의 activeBySpace에서 읽는다(reconcileDocTabs). 그 값은
      // 서버가 tab.close를 처리해 되돌려 줘야 갱신되므로, 이 함수가 곧바로 부르는
      // reconcileDocTabs()보다 한 왕복 늦다. 그사이에는 방금 닫혀 로컬 목록에서 빠진 탭 id를
      // 가리켜 해당 탭을 찾지 못하고 아무것도 그리지 않는다. 위 activeBySpace(로컬)를 즉시
      // 갱신하는 것과 같은 이유로 browser state도 낙관적으로 맞춰 둔다. 실제 브로드캐스트가
      // 오면 같은 값이라 덮어써도 차이가 없다.
      setBrowserActiveTab(target.space, nextActive);
    }
    if (isFileLikeKind(current.kind) && current.path) {
      const stillReferenced = getTabSpaces().some((space) => getTabs(space).some((tab) => isFileLikeKind(tab.kind) && tab.path === current.path));
      if (!stillReferenced) disposeClosedFileModel(current.id);
    }
    // 문서 탭은 이 창이 browser state로부터 받아 만든 것이라, 로컬에서만 지우면 다음 브로드캐스트에
    // 다시 생긴다. 서버 쪽 탭도 함께 닫아야 실제로 닫힌다.
    if (String(current.id).startsWith("browser:") || (BROWSER_MODE && isFileLikeKind(current.kind))) {
      const mutation = { op: "tab.close", space: target.space, id: current.id };
      const navigationHistory = browserHistories && browserHistories.get(String(current.id));
      if (navigationHistory) mutation.navigationHistory = navigationHistory;
      bsMutate(mutation);
    } else {
      // 서버가 모르는 이 창만의 탭이라 복원 스택도 여기서만 쌓을 수 있다. 위 분기로 간 탭을
      // 여기서도 쌓으면 같은 탭이 두 항목으로 남아 ⌘⇧T 의 두 번째 입력이 아무 일도 하지 않는다.
      noteClosedCenterTab(target.space, current);
    }
  }
  if (!changed) return;
  // 분리 창은 자기 탭바를 따로 그린다(renderBmTabs). renderTabs/showActiveTab은 도킹 창 전용이고,
  // persistFileTabs도 이 창엔 보존할 일반 파일 탭이 없어 부르면 도킹 창의 저장분을 덮어쓸 수 있다.
  if (BROWSER_MODE) { renderBmTabs(); reconcileDocTabs(); }
  else { renderTabs(); showActiveTab(); persistFileTabs(); }
  syncWatchDirs(); scheduleWebviewThrottling();
}
export async function closeTabs(targets) {
  if (hasActiveCloseDialog()) return showToast("이미 저장 확인이 열려 있습니다");
  const snapshots = [];
  for (const target of targets || []) {
    const space = target.space || getCenterSpace();
    const tab = target.tabRef || target.ref || getTabs(space).find((item) => item.id === target.tabId);
    if (tab) snapshots.push({ space, tabId: target.tabId || tab.id, tabRef: tab, ref: tab });
  }
  const dirtyTargets = snapshots.filter((target) => isTabDirty(target.tabRef));
  if (!dirtyTargets.length) {
    const browserHistories = await captureBrowserHistories(snapshots);
    removeTabsNow(snapshots, browserHistories);
    return;
  }
  activeCloseDialog = promptDirtyChoice("변경 내용을 저장할까요?", dirtyTargets.map((target) => target.tabRef.label || target.tabRef.path).join("\n"));
  let choice = "cancel";
  try { choice = await activeCloseDialog; }
  finally { activeCloseDialog = null; }
  const liveSnapshots = resolveLiveCloseTargets(snapshots);
  if (choice === "cancel") return;
  if (choice === "discard") {
    const browserHistories = await captureBrowserHistories(liveSnapshots);
    removeTabsNow(liveSnapshots, browserHistories);
    return;
  }
  if (choice === "save") {
    const liveDirtyTargets = dirtyTargets.filter((target) => liveSnapshots.includes(target));
    const saveResults = await Promise.allSettled(liveDirtyTargets.map((target) => saveTabForClose(target.tabRef, target.space)));
    const successfulRefs = new Set(liveSnapshots.filter((target) => !liveDirtyTargets.includes(target)).map((target) => target.tabRef));
    saveResults.forEach((result, index) => { if (result.status === "fulfilled") successfulRefs.add(liveDirtyTargets[index].tabRef); });
    const closableTargets = liveSnapshots.filter((target) => successfulRefs.has(target.tabRef) && !isTabDirty(target.tabRef));
    const browserHistories = await captureBrowserHistories(closableTargets);
    removeTabsNow(closableTargets, browserHistories);
  }
}
function closeTab(id) {
  const tabRef = getTabs(getCenterSpace()).find((tab) => tab.id === id);
  if (tabRef) closeTabs([{ space: getCenterSpace(), tabId: id, tabRef }]);
}
export async function closeActiveTab() {
  // 분리 브라우저 창: 서버 상태의 활성 브라우저 탭을 닫는다(tab-store는 메인 창 구조라 무효).
  if (BROWSER_MODE) {
    const id = bmActiveId();
    if (id) {
      const histories = await captureBrowserHistories([{ space: boundSpace(), tabRef: { id, kind: "browser" } }]);
      const mutation = { op: "tab.close", space: boundSpace(), id };
      const navigationHistory = histories.get(String(id));
      if (navigationHistory) mutation.navigationHistory = navigationHistory;
      bsMutate(mutation);
    }
    return;
  }
  const tabRef = getTabs(getCenterSpace()).find((tab) => tab.id === getActiveTabId(getCenterSpace()));
  if (tabRef) closeTabs([{ space: getCenterSpace(), tabId: tabRef.id, tabRef }]);
}
// 파일 rename/move 후 열린 탭이 옛 경로를 계속 쓰면(편집·저장 시 삭제 파일 재생성 등) 안 되므로 재타깃.
export function retargetFileTabs(oldPath, newPath) {
  if (!oldPath || !newPath) return;
  const monacoModels = getMonacoModels();
  const monacoViewState = getMonacoViewState();
  const monacoEditor = getMonacoEditor();
  const monaco = getMonacoRuntime();
  const oldPref = oldPath + "/";
  const pathMoves = new Map();
  for (const sp of getTabSpaces()) {
    for (const t of getTabs(sp)) {
      if (!isFileLikeKind(t.kind) || !t.path) continue;
      let np = null;
      if (t.path === oldPath) np = newPath;
      else if (t.path.startsWith(oldPref)) np = newPath + "/" + t.path.slice(oldPref.length);
      if (np) {
        const oldId = t.id, oldTabPath = t.path;
        pathMoves.set(oldTabPath, np);
        untrackFileWatch(oldTabPath, sp, oldId);
        t.path = np; t.id = "file:" + np; t.label = np.split("/").pop(); trackFileWatch(sp, t);
        if (getActiveTabId(sp) === oldId) setActiveTab(sp, t.id);
        for (const registryItem of tabIoRegistry) {
          const entry = registryItem[1];
          if (entry.tabRef !== t) continue;
          entry.path = np; entry.tabId = t.id; entry.owner = { space: sp, tabId: t.id };
        }
        if (t._saving) t._saving.path = np;
        callHook("viewer.retargetTabPath", t, np);
      }
    }
  }
  for (const [oldKey, np] of pathMoves) {
    const oldModel = monacoModels.get(oldKey);
    const oldViewState = monacoViewState.get(oldKey);
    if (oldModel) {
      const currentValue = oldModel.getValue();
      const wasAttached = !!(monacoEditor && monacoEditor.getModel() === oldModel);
      const attachedViewState = wasAttached ? monacoEditor.saveViewState() : oldViewState;
      oldModel.dispose();
      monacoModels.delete(oldKey);
      const newModel = monaco.editor.createModel(currentValue, monacoLangFor(np), monaco.Uri.file(np));
      monacoModels.set(np, newModel);
      if (wasAttached) monacoEditor.setModel(newModel);
      if (attachedViewState) monacoViewState.set(np, attachedViewState);
      if (wasAttached && attachedViewState) monacoEditor.restoreViewState(attachedViewState);
    } else if (oldViewState) monacoViewState.set(np, oldViewState);
    monacoViewState.delete(oldKey);
  }
  renderTabs(); showActiveTab(); persistFileTabs();
}
function discardTabFingerprint(t) {
  // 뷰어의 상태는 뷰어가 만든다. 그 뷰어를 끄면 undefined 이므로 반환값을 바로 참조하지 않는다.
  const view = callHook("viewer.discardSnapshot", t) || null;
  return {
    draft: t.draft,
    saving: t._saving || null,
    saveInFlight: t._saveInFlight || null,
    view,
  };
}
function sameDiscardFingerprint(a, b) {
  if (!(a.draft === b.draft && a.saving === b.saving && a.saveInFlight === b.saveInFlight)) return false;
  // 뷰어가 없으면 비교할 뷰어 상태도 없다. 답이 없는 것을 변경으로 읽으면 텍스트 탭의
  // 되돌리기가 항상 취소된다. 훅이 명시적으로 false 를 줄 때만 다른 것으로 본다.
  if (!a.view && !b.view) return true;
  return callHook("viewer.sameDiscardSnapshot", a.view, b.view) !== false;
}
function commitDiscardTab(t, staged, space) {
  const monacoModels = getMonacoModels();
  const centerSpace = getCenterSpace();
  callHook("viewer.closeEdit", t, false);
  const content = staged.content !== undefined ? staged.content : null;
  t.content = content;
  t.draft = null;
  // 방금 디스크에서 다시 읽어온 것이 새 기준이다. 안 옮기면 되돌린 직후의 저장이 충돌로 막힌다.
  if (typeof staged.revision === "string") t.revision = staged.revision;
  t._saving = false;
  t._saveInFlight = null;
  t.gone = false;
  t.hasDiskSnapshot = true;
  // 뷰어가 들고 있던 상태는 뷰어가 비운다. 여기서 필드를 나열하면 필드가 늘 때마다 앱 셸을 고쳐야 한다.
  callHook("viewer.resetAfterDiscard", t, staged);
  // 사용자 입력이 아니다. 같은 경로를 다른 스페이스에서도 열어 두면 모델이 하나뿐이라,
  // 여기서 setValue 하면 그 변경 알림이 현재 활성인 다른 탭에 draft 를 기록한다.
  resetModelTextExternally(t.path, content || "");
  t.draft = null;
  const activeTab = centerSpace === space
    ? getTabs(centerSpace).find((tab) => tab.id === getActiveTabId(centerSpace) && tab === t)
    : null;
  if (activeTab === t) renderFileView(t);
  renderTabs();
}
export async function discardTabToDisk(target) {
  const space = target && target.space;
  const tabId = target && target.tabId;
  const tabRef = target && target.tabRef;
  const path = tabRef && tabRef.path;
  if (!space || !tabId || !path || !tabRef.hasDiskSnapshot) return false;
  const fingerprint = discardTabFingerprint(tabRef);
  let textResponse = null, sheetResponse = null;
  try {
    // 되돌리려면 무엇을 다시 읽어야 하는지는 파일 종류가 안다. 맡는 종류가 없으면 텍스트만 읽는다.
    const kind = fileKindOf(path, tabRef);
    const plan = kind ? kind.discardReads(path) : { text: true, data: false };
    const jobs = [];
    if (plan.text) jobs.push(sendTabIo({ type: "fs.read", path, space, tabId, reason: "discard" })
      .then((r) => { textResponse = r; }));
    if (plan.data) jobs.push(sendTabIo({ ...kind.read(path), space, tabId, reason: "discard" })
      .then((r) => { sheetResponse = r; }));
    await Promise.all(jobs);
  } catch (e) {
    return false;
  }
  if (textResponse && textResponse.error || sheetResponse && sheetResponse.error) return false;
  const liveTab = getTabs(space).find((tab) => tab === tabRef && tab.id === tabId);
  if (!liveTab || !(liveTab.path === path)) return false;
  const currentFingerprint = discardTabFingerprint(liveTab);
  if (!sameDiscardFingerprint(fingerprint, currentFingerprint)) return false;
  commitDiscardTab(liveTab, {
    content: textResponse ? textResponse.content : undefined,
    revision: textResponse ? textResponse.revision : undefined,
    sheet: sheetResponse ? sheetResponse.data : undefined,
  }, space);
  return true;
}
// 이 스페이스의 탭을 전부 닫는다. 저장하지 않은 편집이 있으면 먼저 알린다. 확인 없이 닫으면
// 되돌릴 수 없다.
// 메뉴는 반드시 이 함수를 호출해야 한다. 메뉴가 같은 처리를 따로 구현하면 여기의 미저장
// 경고가 뜨지 않고, 함수의 존재만 확인하는 검사는 그 상태를 통과시킨다.
export function closeAllTabs() {
  const list = getCurrentTabs().slice();
  if (!list.length) return;
  const dirty = list.filter((tab) => isTabDirty(tab));
  if (dirty.length) showToast(`저장하지 않은 편집이 ${dirty.length}개 있습니다`);
  closeTabs(list.map((tabRef) => ({ space: getCenterSpace(), tabId: tabRef.id, tabRef })));
}

function initTabCloseEvents() {
  tabstrip.addEventListener("click", (e) => {
    const close = e.target.closest(".cclose");
    if (close) { e.stopPropagation(); const tabRef = getCurrentTabs().find((tab) => tab.id === close.dataset.close); if (tabRef) closeTabs([{ space: getCenterSpace(), tabId: tabRef.id, tabRef }]); return; }
    const tab = e.target.closest(".ctab");
    if (tab) { const tid = tab.dataset.tab; setActiveTab(getCenterSpace(), tid); renderTabs(); showActiveTab(); persistFileTabs();
      if (String(tid).startsWith("browser:")) bsMutate({ op: "tab.switch", space: getCenterSpace(), id: tid }); }
  });
  // 콘솔 탭바 우클릭. 파일 탭이면 파일 트리와 같은 동작을 할 수 있어야 하므로,
  // 메뉴를 새로 만들지 않고 트리와 같은 openFileCtx를 쓰고 그 아래 탭 닫기 항목만 추가한다.
  tabstrip.addEventListener("contextmenu", (e) => {
    if (BROWSER_MODE) return;                       // 분리 창은 자기 브라우저 탭 메뉴가 따로 있다
    const tab = e.target.closest(".ctab"); if (!tab) return;
    e.preventDefault(); e.stopPropagation();
    const id = tab.dataset.tab;
    const t = getCurrentTabs().find((x) => x.id === id); if (!t) return;
    const extra = [];
    const discardTarget = { space: getCenterSpace(), tabId: id, tabRef: t };
    if (isFileLikeKind(t.kind) && t.path) extra.push({ label: "수정 사항 모두 취소", disabled: !t.hasDiskSnapshot,
      act: () => discardTabToDisk(discardTarget) });
    extra.push({ sep: true });
    extra.push({ label: "탭 닫기", act: () => closeTabs([{ space: getCenterSpace(), tabId: id, tabRef: t }]) });
    extra.push({ label: "다른 탭 모두 닫기", disabled: getCurrentTabs().length < 2,
      act: () => closeTabs(getCurrentTabs().filter((v) => v.id !== id).map((tabRef) => ({ space: getCenterSpace(), tabId: tabRef.id, tabRef }))) });
    extra.push({ label: "모두 닫기", danger: true, act: () => closeAllTabs() });
    if (isFileLikeKind(t.kind) && t.path) { openFileCtx(e.clientX, e.clientY, t.path, false, extra); return; }
    showCtx(e.clientX, e.clientY, extra.slice(1));  // 파일이 아니면 닫기 계열만(앞의 구분선 제거)
  }, true);

  // 도킹 브라우저 탭 이름 더블클릭 편집. 터미널·파일 탭은 제외하고 브라우저 탭만 처리한다.
  tabstrip.addEventListener("dblclick", (e) => {
    const nameEl = e.target.closest(".cname"); const tab = e.target.closest(".ctab");
    if (!nameEl || !tab) return; const id = tab.dataset.tab;
    if (!String(id).startsWith("browser:")) return; e.stopPropagation();
    const sp = getCenterSpace();
    const browserState = getBrowserState();
    const st = ((browserState.tabsBySpace && browserState.tabsBySpace[sp]) || []).find((x) => x.id === id);
    startTabRename(nameEl, (st && st.name) || (st && st.title) || "", (v) => {
      if (v !== null) bsMutate({ op: "tab.rename", space: sp, id, name: v });
      renderTabs(); // 이름이 바뀌지 않아 서버 broadcast 가 없을 때도 편집 input 이 남지 않도록 항상 재렌더
    });
  });
}

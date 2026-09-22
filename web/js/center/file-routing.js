// 파일 라우팅. 파일·문서·브라우저·터미널 링크를 알맞은 center 표면으로 보낸다.
//
// 소유 범위
//   파일 형식 판정, 터미널 경로 정규화·Finder reveal, 로컬/분리 문서 열기와 브라우저 진입 분기.
//
// 제공 API
//   initFileRouting(deps), openFile·openBrowser·openInSpaceBrowser, 터미널 링크/경로 handler,
//   consoleSpace, 그리고 브라우저 안에서 누른 로컬 링크의 처리(openLocalLink·openDownloadedLocal·
//   APP_DRAWN_LINK_EXTS). 어떤 확장자가 표·문서인지는 여기서 판정하지 않는다. core/file-kinds.js 에
//   기능이 스스로 등록하고, 이 파일은 그 경로를 누가 맡는지만 조회한다.
//
// 의존 대상
//   main의 core DOM·notice·host/agent 상태와 browser mutation 서비스를 init에서 받는다.
//   center 탭 생성·활성화는 tab-store command/query를 같은 영역 import로 사용한다.
//
// 유지 조건
//   docx/sheet의 도킹·분리 위치, HTML·SVG·PDF의 브라우저 경로, 바이너리 Finder fallback,
//   루트 없는 터미널 토큰만 workspace 경계로 거르는 순서와 ⌘⇧ reveal 제스처.
//   분리 브라우저 창에서 텍스트 파일을 openFileLocal 로 열지 않는다. 그 창에는 텍스트 탭 영역이
//   없어 아무도 그리지 않는 탭이 생긴다. 문서 탭이 등록되는 스페이스도 같은 이유로 그 창이
//   보고 있는 것이어야 한다(boundSpace).
//
// 영향 범위
//   tab-store API, main의 selectedSpaceId·hostHome·lastAgents,
//   browser sbState/newBrowserTab, Explorer·xterm 링크, sheet/docx 읽기와 탭 복원.

import { fileKindOf } from "../core/file-kinds.js";
import {
  addTab, ensureTabSpace, getCenterSpace, getTabs, setActiveTab, setCenterSpace,
} from "./tab-store.js";
import { boundSpace, bsMutate, getBrowserState } from "../browser/state.js";

let $, showToast, acHost, terminalBarePathToken, agentByPane;
let BROWSER_MODE, makeFileTab, requestFileContent, trackFileWatch;
let renderTabs, showActiveTab, persistFileTabs, syncWatchDirs, newBrowserTab;
let getHostHome, getCurTarget, getLastAgents, getSelectedSpaceId;

export const WEB_DOC_RE = /\.(html?|svg|pdf)$/i;
// 뷰어로 열 수 없는 형식이라 Finder 로 보여 준다. 표·문서 확장자(xlsx·xlsm·docx)가 함께 있는
// 것은 표·문서 뷰어를 껐을 때를 위한 것이다. 켜져 있으면 등록표가 먼저 처리하므로 오지 않는다.
export const BINARY_RE = /\.(apk|aab|ipa|app|dmg|pkg|zip|gz|tgz|bz2|xz|7z|rar|jar|war|so|dylib|a|o|bin|exe|wasm|png|jpe?g|gif|webp|bmp|tiff?|ico|icns|heic|mp[34]|m4[av]|mov|avi|mkv|wav|aiff?|flac|ttf|otf|woff2?|sqlite3?|db|xls|xlsx|xlsm|doc|docx|pptx?|key|numbers|pages)$/i;

export function initFileRouting(deps) {
  ({ $, showToast, acHost, terminalBarePathToken, agentByPane, BROWSER_MODE,
    makeFileTab, requestFileContent, trackFileWatch, renderTabs, showActiveTab,
    persistFileTabs, syncWatchDirs, newBrowserTab, getHostHome, getCurTarget,
    getLastAgents, getSelectedSpaceId } = deps);
}

export function openFile(path) {
  // 이 경로를 어느 뷰어가 맡는지는 등록표가 안다. 맡는 뷰어가 없으면 텍스트 파일로 열고,
  // 텍스트로 열 수 없는 형식은 Finder 로 보낸다. 그러지 않으면 png·zip 이 텍스트 편집기에
  // 깨져서 표시된다.
  if (fileKindOf(path)) { openDocInSpaceBrowser(path); return; }
  if (BINARY_RE.test(path)) {
    try { acHost && acHost.revealInFinder && acHost.revealInFinder(path); } catch (e) {}
    showToast("뷰어로 열 수 없는 형식입니다. Finder에서 보여줍니다");
    return;
  }
  openFileLocal(path);
}

export function openFileLocal(path) {
  const sp = getCenterSpace() || getSelectedSpaceId();
  if (!sp) { showToast("파일을 열 스페이스가 없습니다. 왼쪽에서 스페이스를 고르세요"); return; }
  ensureTabSpace(sp);
  const id = "file:" + path;
  if (!getTabs(sp).find((t) => t.id === id)) {
    const tab = addTab(sp, makeFileTab(path)); requestFileContent(path); trackFileWatch(sp, tab);
  }
  setCenterSpace(sp); setActiveTab(sp, id); renderTabs(); showActiveTab(); persistFileTabs(); syncWatchDirs();
  if (window.innerWidth <= 820) $("#center").classList.add("mobile-show");
}

export function openDocInSpaceBrowser(path) {
  const state = getBrowserState();
  if (!BROWSER_MODE && state.docked) { openFileLocal(path); return; }
  // 분리 브라우저 창에서는 그 창이 보고 있는 스페이스를 쓴다. 콘솔의 센터 스페이스를 쓰면
  // 그 창이 보고 있지 않은 스페이스에 탭이 생기고, dock.js 의 reconcileDocTabs 는 보고 있는
  // 스페이스만 그리므로 아무도 그리지 않는 탭이 된다. 두 값은 실제로 갈릴 수 있다.
  // 새 브라우저 탭도 같은 규칙으로 스페이스를 고른다(main.js 의 newBrowserTab).
  const sp = (BROWSER_MODE && boundSpace()) || consoleSpace();
  if (!sp) { showToast("문서를 열 스페이스가 없습니다. 왼쪽에서 스페이스를 고르세요"); return; }
  bsMutate({ op: "space.active", space: sp });
  if (!BROWSER_MODE && !state.docked) { try { acHost && acHost.openBrowser && acHost.openBrowser(); } catch (e) {} }
  const id = "file:" + path;
  // 여기로 오는 것은 등록표가 맡는 파일뿐이다(openFile 이 그렇게 거른다). 그래도 외부에서
  // 호출할 수 있는 이름이라 한 번 더 확인한다. 등록이 없을 때 "sheet" 로 넘기면 앱 셸이 뷰어의
  // 종류 이름을 아는 셈이 되고, 그 뷰어를 끄면 아무도 그리지 않는 탭이 열린다.
  const spec = fileKindOf(path);
  if (!spec) { openFileLocal(path); return; }
  const kind = spec.id;
  const existing = ((state.tabsBySpace && state.tabsBySpace[sp]) || []).find((t) => t.id === id);
  if (existing) { bsMutate({ op: "tab.switch", space: sp, id }); return; }
  bsMutate({ op: "tab.open", space: sp, id, kind, path, title: path.split("/").pop() });
}

function fileUrlOf(absPath) { return "file://" + absPath.split("/").map(encodeURIComponent).join("/"); }

function resolveTerminalPath(raw) {
  let p = terminalBarePathToken(raw).replace(/:\d+.*$/, "");
  const hostHome = getHostHome();
  if (p === "~" || p.startsWith("~/")) { if (!hostHome) return null; p = hostHome.replace(/\/$/, "") + p.slice(1); }
  else if (p.startsWith("~")) return null;
  if (!p.startsWith("/")) {
    const curTarget = getCurTarget();
    const a = curTarget ? agentByPane(curTarget) : null, base = a && a.cwd; if (!base) return null;
    p = base.replace(/\/$/, "") + "/" + p.replace(/^\.\//, "");
  }
  const parts = []; for (const seg of p.split("/")) { if (seg === "..") parts.pop(); else if (seg !== "." && seg !== "") parts.push(seg); }
  return "/" + parts.join("/");
}

export function revealTerminalPath(raw) {
  const p = resolveTerminalPath(raw); if (!p) return;
  try { acHost && acHost.revealInFinder && acHost.revealInFinder(p); } catch (e) {}
}

export function openTerminalPath(raw) {
  const p = resolveTerminalPath(raw);
  const hostHome = getHostHome();
  if (!p) { showToast(hostHome ? "경로를 해석할 수 없습니다: " + raw : "서버에서 홈 경로를 아직 못 받았습니다"); return; }
  if (WEB_DOC_RE.test(p)) { openInSpaceBrowser(fileUrlOf(p)); return; }
  if (fileKindOf(p)) { openFile(p); return; }
  if (BINARY_RE.test(p)) { revealTerminalPath(raw); showToast("뷰어로 열 수 없는 형식입니다. Finder에서 보여줍니다"); return; }
  const rooted = /^[/~]/.test(String(raw || "").trim());
  if (!rooted) {
    // 조용히 반환하지 않는다. 눌렀는데 아무 일도 일어나지 않으면 기능이 고장 난 것으로 보이고,
    // 무엇이 막았는지 알아야 다음 동작을 고를 수 있다.
    if (!/\.[A-Za-z0-9]{1,10}$/.test(p)) {
      showToast("파일 이름으로 안 보여 열지 않았습니다. 전체 경로면 엽니다: " + raw);
      return;
    }
    const roots = [...new Set(getLastAgents().map((a) => a.cwd).filter(Boolean).map((c) => c.replace(/\/$/, "")))];
    if (!roots.some((r) => p === r || p.startsWith(r + "/"))) {
      showToast("작업 폴더 밖이라 열지 않았습니다. 전체 경로면 엽니다");
      return;
    }
  }
  openFile(p);
}

// 브라우저가 그릴 수 있는 것은 브라우저가 그린다. 예외는 마크다운으로, 브라우저는 원문 그대로
// 보여주지만 앱에는 원문·미리보기를 가진 텍스트 탭이 있다. 이 목록은 렌더러가 소유하고
// main 은 사본만 받는다(acHost.setAppDrawnLinkExts). webview 안에서 누른 링크는 렌더러
// 이벤트로 오지 않으므로 그쪽 판정도 같은 표를 참조해야 한다. 단축키 표를 넘기는 이유와 같다.
export const APP_DRAWN_LINK_EXTS = ["md", "markdown"];

// 브라우저 안에서 누른 로컬 링크. 브라우저가 못 그리는 것(표·문서·바이너리)과 앱이 그리기로 한
// 것(마크다운)이 여기로 온다. 어디로 갈지는 등록표가 정하고, 이 함수는 열 위치만 고른다.
export function openLocalLink(target) {
  const p = pathOfTarget(String(target || ""));
  if (!p) return;
  // html·svg·pdf 는 브라우저가 잘 그린다. 주소를 그대로 넘겨 물음표·조각(#)을 잃지 않는다.
  if (WEB_DOC_RE.test(p)) { openInSpaceBrowser(/^file:\/\//i.test(String(target)) ? String(target) : fileUrlOf(p)); return; }
  // 텍스트 파일이 열리는 편집기 탭은 콘솔 창에만 있다. 분리 브라우저 창에는 그 영역이 없으므로
  // (dock.js 의 reconcileDocTabs 는 등록된 종류의 탭만 만든다) 콘솔 창으로 넘기고 앞으로 부른다.
  if (BROWSER_MODE && !fileKindOf(p) && !BINARY_RE.test(p)) {
    try { acHost && acHost.openInConsole && acHost.openInConsole(p); } catch (e) {}
    return;
  }
  openFile(p);
}

// 내려받기가 끝난 뒤 호출된다. 뷰어가 맡는 종류만 열고 나머지는 저장으로 끝낸다.
// 여기로 오는 것은 로컬(loopback)에서 받은 파일뿐이다. 일반 웹에서 받은 파일까지 열면
// 사용자가 요청하지 않은 창이 뜬다.
export function openDownloadedLocal(path) {
  const p = String(path || "");
  if (!p || !fileKindOf(p)) return;
  openDocInSpaceBrowser(p);
}

export function openDroppedLocal(path) {
  if (fileKindOf(path)) { openDownloadedLocal(path); return; }
  openInSpaceBrowser(fileUrlOf(path));
}

export function consoleSpace() { return getCenterSpace() || getSelectedSpaceId() || "_"; }

export function openBrowser() {
  const sp = consoleSpace();
  setCenterSpace(sp);
  const state = getBrowserState();
  bsMutate({ op: "space.active", space: sp });
  if (!state.docked) {
    if (acHost && acHost.openBrowser) acHost.openBrowser();
  } else {
    const existing = (state.tabsBySpace && state.tabsBySpace[sp]) || [];
    if (existing.length === 0) newBrowserTab();
  }
  if (window.innerWidth <= 820) $("#center").classList.add("mobile-show");
}

export function openInSpaceBrowser(url) {
  if (!BROWSER_MODE && !getBrowserState().docked) { try { acHost && acHost.openBrowser && acHost.openBrowser(); } catch (e) {} }
  newBrowserTab(url);
}

export const wantsReveal = (ev) => !!(ev && ev.shiftKey && (ev.metaKey || ev.ctrlKey));

function pathOfTarget(s) {
  if (/^file:\/\//i.test(s)) { try { return decodeURIComponent(s.replace(/^file:\/\//i, "").replace(/[?#].*$/, "")); } catch (e) { return null; } }
  if (s.startsWith("/") || s.startsWith("~")) return s;
  return null; // http(s)는 파일이 아니다
}

export function openTerminalTarget(target, ev) {
  const s = String(target || "").trim();
  if (wantsReveal(ev)) { const fp = pathOfTarget(s); if (fp) { revealTerminalPath(fp); return; } }
  if (/^(https?|file):\/\//i.test(s)) { openTerminalLink(s); return; }
  if (s.startsWith("/") || s.startsWith("~")) { openTerminalPath(s); return; }
}

export function openTerminalLink(uri, ev) {
  const u = String(uri || "").trim();
  if (wantsReveal(ev)) { const fp = pathOfTarget(u); if (fp) { revealTerminalPath(fp); return; } }
  if (/^https?:\/\//i.test(u)) { openInSpaceBrowser(u); return; }
  if (/^file:\/\//i.test(u)) {
    let p; try { p = decodeURIComponent(u.replace(/^file:\/\//i, "").replace(/[?#].*$/, "")); } catch (e) { p = ""; }
    if (!p.startsWith("/")) return;
    if (WEB_DOC_RE.test(p)) { openInSpaceBrowser(fileUrlOf(p)); return; }
    openTerminalPath(p);
  }
}

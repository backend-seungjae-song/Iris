// 소유 범위: 세션 전용 탭 생성과 고정 지속. 세션이 자기 탭을 갖고 재시작 후에도 유지한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/session-tabs.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserHandles, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2h] 세션 전용 탭 생성 · 고정 지속");
const srvH = read("server/index.js"), bstateH = read("server/browser-state.js");
// 병렬 작업: 세션마다 자기 탭. 만드는 곳은 자기 스페이스뿐이라 스페이스 경계는 그대로다.
check("자기 스페이스에만 만든다", () => {
  const seg = sliceBetween(browserCommands, "function createTabForSession", "function runBrowserCmd", "자기 스페이스에만 만든다");
  return /const mine = sessionSpace\(session\)/.test(seg) && /space: mine/.test(seg)
    && !/SHARED_SPACE/.test(seg) && !/grantTab/.test(seg); // 경계를 넘는 통로를 새로 열지 않음
});
check("세션 없으면 만들지 않음", () => {
  const seg = sliceBetween(browserCommands, "function createTabForSession", "function runBrowserCmd", "세션 없으면 만들지 않음");
  return /if \(!session\)/.test(seg) && /if \(!mine\)/.test(seg);
});
check("사용자 화면을 가로채지 않음(백그라운드)", () => {
  const seg = sliceBetween(browserCommands, "function createTabForSession", "function runBrowserCmd", "사용자 화면을 가로채지 않음(백그라운드)");
  return /background: true/.test(seg) && /if \(!m\.background\) state\.activeBySpace\[sp\] = m\.id/.test(bstateH);
});
// 엄격한 고정이 아니라 "마지막으로 쓴 탭"이다. 고정이면 그 탭이 닫히는 순간 세션이 끊기고,
// 같은 그룹에 탭을 더 만들어 오갈 수도 없다.
check("만든 탭은 세션 그룹에 들어가고 핸들을 돌려준다", () => {
  const seg = sliceBetween(browserCommands, "function createTabForSession", "function runBrowserCmd", "만든 탭은 세션 그룹에 들어가고 핸들을 돌려준다");
  return /const gid = ensureSessionGroup\(session\)/.test(seg)
    && /op: "tab\.open"[^}]*group: gid \|\| undefined/.test(seg)
    && /setLastTab\(String\(session\), id\)/.test(seg)
    && /data: \{ handle: h, tabId: id, space: mine/.test(seg);   // 밖으로 나가는 것은 핸들·정체성뿐
});
check("wc는 렌더러 보고를 기다려 받는다(추측 금지)", () =>
  /function waitForTabWc/.test(browserRuntime) && /tabWcWaiters/.test(browserRuntime) && /waitForTabWc\(id, 12000\)/.test(browserCommands));
check("띄우지 못하면 실패로 알린다", () => {
  const seg = sliceBetween(browserCommands, "function createTabForSession", "function runBrowserCmd", "띄우지 못하면 실패로 알린다");
  return /if \(!wc\) \{/.test(seg) && /브라우저 창이 그것을 띄우지 못했습니다/.test(seg);
});
// 지속 사용: wc는 webview가 다시 만들어질 때마다 바뀌므로, 고정은 탭 식별자에 묶는다.
check("고정은 wc가 아니라 탭 정체성에 묶임", () =>
  /const pinnedTabsByPane = new Map\(\)/.test(browserRuntime) && /function wcOfTabId/.test(browserRuntime));
// webview를 다시 만들어도 대상은 유지된다. 대상 자체가 식별자라 다시 연결할 것이 없다. 아직 뜨지 않은
// 탭과 닫힌 탭만 구분한다.
check("webview 재생성은 대상을 흔들지 않는다", () => {
  const seg = sliceFrom(browserRuntime, "function resolveTarget", 1100, "webview 재생성은 대상을 흔들지 않는다");
  return /if \(tabReg\.has\(tabId\)\) return \{ tabId, pinned: true \}/.test(seg)
    && /if \(tabExistsInState\(tabId\)\) return \{ tabId: null, notReady: true, waitTab: tabId \}/.test(seg)
    && /staleP: true, deadTab: tabId/.test(seg);
});
// 에이전트가 사용하는 식별자는 wc가 아니다. wc는 webview를 다시 만들 때마다 재발급되어
// 앱을 껐다 켜면 같은 번호가 다른 탭을 가리킨다(확인 결과: 재시작 전 @4=Google → 후 @4=Example Domain).
// 핸들은 `<스페이스>-tab-<난수>`다. `t83` 같은 순번은 로그·MCP 호출에서 어느 스페이스의
// 무엇인지 알 수 없다. 앞의 이름은 읽기 위한 것이고 식별자는 뒤의 난수다.
// 순번이면 스페이스가 나뉘거나 합쳐질 때마다 다시 매겨야 하고, 그때마다 기존 이름이 무효가 된다
// (확인 결과: 스페이스별 번호라 `/Acme`과 `/Acme/acme`이 둘 다 acme-tab-1).
// 분리한 모듈이 이전 모듈의 심볼을 참조하는지 실제로 호출해 확인한다. 코드 모양 검사와
// node --check 는 이것을 잡지 못한다. 핸들을 분리할 때 handleRec·legacyHandle·groupRec·HANDLE_PATH·SHARED_SPACE
// 다섯이 이전 위치에 남았는데 검사 1,189개가 모두 통과했고, 실동작 테스트가 10초 시간 초과로
// 하나씩만 드러냈다. 여기서는 공개 함수를 전부 호출해 한 번에 찾는다.
await checkAsync("손잡이 모듈은 자기 밖의 이름을 부르지 않는다", async () => {
  const { createTabHandles } = await import(new URL("../../../server/browser/tab-handles.js", import.meta.url).href);
  const tabReg = new Map([["t-1", { wc: 5, space: "X", url: "u", title: "t" }]]);
  const h = createTabHandles({ tabReg, SHARED_SPACE: "__shared__" });
  const rec = (space, kind) => ({ space, kind, h: "a1b2c3", n: 1, slugs: ["x"], dirs: [] });
  const calls = [
    ["newHandleHash", []], ["loadTabHandles", []], ["loadGroupHandles", []],
    ["persistHandles", []], ["flushHandlesNow", []], ["writeHandlesNow", []],
    ["spaceSlug", ["X"]], ["spaceSlug", ["__shared__"]], ["spaceSlug", [""]], ["spaceSlug", [null]],
    ["tabSpaceOf", ["t-1"]], ["tabSpaceOf", ["없는탭"]],
    ["renderHandle", [rec("X", "tab")]], ["renderHandle", [rec("__shared__", "group")]],
    ["handleFor", ["t-1"]], ["handleFor", ["없는탭"]], ["groupHandleFor", ["X", "g1"]],
  ];
  const leaks = new Set();
  for (const [name, args] of calls) {
    if (typeof h[name] !== "function") { leaks.add(`${name}: 내주지 않는다`); continue; }
    // 인자가 틀려서 나는 오류는 대상이 아니다. ReferenceError 만 검사한다.
    try { h[name](...args); } catch (error) { if (error instanceof ReferenceError) leaks.add(`${name}: ${error.message}`); }
  }
  if (leaks.size) throw new Error(`옛 이웃을 부른다 — ${[...leaks].join(" · ")}`);
  return true;
});
check("핸들 정체성은 세는 값이 아니라 난수", () =>
  /const handleRec = new Map\(\)/.test(browserHandles)
  && /function spaceSlug/.test(browserHandles)
  && /return `\$\{slug\}-\$\{r\.kind\}-\$\{r\.h\}`/.test(browserHandles)
  && /if \(!r\.slugs\.includes\(slug\)\)/.test(browserHandles)   // 옛 이름을 별칭으로 남긴다
  && /function groupHandleFor\(space, gid\)/.test(browserHandles)
  && /function newHandleHash\(\)/.test(browserHandles)
  && /crypto\.randomBytes\(4\)\.toString\("hex"\)/.test(browserHandles)
  // 부정 단언은 소유 파일까지 확인해야 한다. 핸들이 tab-handles.js 로 옮겨간 뒤에도 여기서
  // browser-runtime 만 보면, 그 파일에 카운터가 다시 생겨도 통과한다.
  && ![browserRuntime, browserHandles].some((src) => /handleSeqBySpace/.test(src))
  && ![browserRuntime, browserHandles].some((src) => /nextHandleN/.test(src))   // 세는 값은 남아 있지 않다
  && /if \(!handleHashes\.has\(h\)\) \{ handleHashes\.add\(h\); return h; \}/.test(browserHandles));
// 복원은 이름이 아니라 경로로 연결한다. 폴더 이름은 겹칠 수 있지만 실제 경로는 겹치지 않는다.
check("핸들에 그때의 폴더 실경로를 남긴다", () =>
  /if \(!r\.dirs\.includes\(dir\)\)/.test(browserHandles)
  && /dirsBySpace/.test(browserStateOwner));
check("탭 지목은 핸들·정체성으로만 (맨 숫자는 안 받는다)", () => {
  const seg = sliceFrom(browserRuntime, "function tabIdOfRef", 2400, "탭 지목은 핸들·정체성으로만 (맨 숫자는 안 받는다)");
  return /\(\?:tab\|group\)-\(\[a-z\]\[0-9a-f\]\{5\}\)\$/.test(seg)  // 난수 이름: 이것이 정식
    && /for \(const \[tabId, r\] of handleRec\) if \(r\.h === h\) return tabId;/.test(seg) // 앞 이름은 안 본다
    && /\^\(\.\*\)-\(tab\|group\)-\(\\d\+\)\$/.test(seg)   // 옛 번호 이름도 계속 받는다
    && /\^t\\d\+\$\/\.test\(s\)/.test(seg)                 // 그보다 옛 t83
    && !/Number\.isFinite\(n2\)/.test(seg);   // 맨 wc 숫자 경로는 없다. 그 번호는 재발급된다
});
// 레지스트리 키가 탭 식별자라 같은 탭이 둘로 보이지 않는다. 재등록은 그 항목을 덮어쓰고
// 이전 wc 역인덱스만 제거한다. 식별자 없는 등록은 받지 않는다.
check("한 탭은 레지스트리에 한 자리", () => {
  const seg = sliceFrom(browserMessages, 'msg.type === "browser-tab-wc"', 1800, "한 탭은 레지스트리에 한 자리");
  return /if \(!msg\.tabId\) return;/.test(seg) && /const meta = \{ wc, url:/.test(seg)
    && /regTab\(msg\.tabId, meta\)/.test(seg)
    && /if \(prev && prev\.wc != null && prev\.wc !== meta\.wc\) tabIdByWc\.delete\(prev\.wc\)/.test(browserRuntime);
});
check("webview를 버릴 때 등록도 회수", () => {
  // 프로필 불일치 재생성 분기에서만 회수가 빠져 중복이 생겼다(확인 결과).
  const seg = fnBody(dock, "reconcileBrowserMode");
  return /dataset\.profile !== wantProfile\) \{ forgetTabWc\(rec, t\.id\)/.test(seg)
    && /function forgetTabWc\(rec, tabId\)/.test(webviewFactory);   // 사라짐도 정체성으로 보고한다
});
// 열려 있는 탭을 다른 파티션으로 옮기면 그 탭의 로그인이 끊긴다. 옮기는 것은 그
// 탭이 자체 계정을 가진 경우로 제한한다. 스페이스 기본값이 바뀌었다는 이유로 이미 열린
// 탭을 옮기면 사용자에게는 사용 중 로그아웃으로 보인다.
check("기본 계정이 바뀌어도 살아 있는 탭은 제 세션에 남는다", () => {
  const seg = fnBody(dock, "reconcileBrowserMode");
  return /const mayRepartition = isBrowserStateLoaded\(\) && t\.profile != null;/.test(seg)
    && /if \(rec && rec\.el && mayRepartition && rec\.el\.dataset\.profile !== wantProfile\)/.test(seg);
});
check("화면에 적히는 계정은 그 탭이 실제로 붙은 세션이다", () => {
  const seg = fnBody(profiles, "profileOfTab");
  return /const live = getWebview\(tabId\);/.test(seg)
    && /return live\.el\.dataset\.profile;/.test(seg);
});
// 재우기는 앱 내부 동작이다. 깨울 때 현재 기본 계정으로 다시 풀면 그 사이 기본값이 바뀌었을 때
// 다른 파티션에 연결된다. 문자열이 아니라 실제 함수를 실행해 검사한다.
check("잠든 탭은 잠들기 전 그 세션으로 깬다", () => {
  const made = [];
  const discarded = { t1: { url: "https://x.test", profile: "p_old", discardedAt: 0 } };
  const wake = new Function(
    "getWebview", "getDiscardedWebview", "removeDiscardedWebview", "storedBrowserTab", "spaceDefaultProfile", "profileIdForStored",
    "setTabStatus", "createWebview", "markWebviewUsed", "bNote", "showToast",
    fnBody(webview, "wakeWebview") + "\nreturn wakeWebview;")(
      () => null,
      (tabId) => discarded[tabId] || null,
      (tabId) => { delete discarded[tabId]; },
      () => ({ sp: "w1", tab: { url: "https://x.test", profile: null } }),
      () => "p_new_default",              // 그 사이 스페이스 기본이 바뀌었다
      (v) => String(v || ""),
      () => {},
      (tabId, profile, url) => { made.push(profile); return { tabId, profile, url }; },
      () => {},
      { textContent: "", hidden: true },
      () => {});
  const rec = wake("t1");
  return rec && made.length === 1 && made[0] === "p_old";
});
check("잠든 기록이 없으면 예전대로 저장된 값·기본값을 따른다", () => {
  const made = [];
  const discarded = {};
  const wake = new Function(
    "getWebview", "getDiscardedWebview", "removeDiscardedWebview", "storedBrowserTab", "spaceDefaultProfile", "profileIdForStored",
    "setTabStatus", "createWebview", "markWebviewUsed", "bNote", "showToast",
    fnBody(webview, "wakeWebview") + "\nreturn wakeWebview;")(
      () => null,
      (tabId) => discarded[tabId] || null,
      (tabId) => { delete discarded[tabId]; },
      () => ({ sp: "w1", tab: { url: "https://x.test", profile: null } }),
      () => "p_space_default",
      (v) => String(v || ""),
      () => {},
      (tabId, profile) => { made.push(profile); return { tabId, profile }; },
      () => {},
      { textContent: "", hidden: true },
      () => {});
  wake("t1");
  return made.length === 1 && made[0] === "p_space_default";
});
check("공유 브라우저 창은 에이전트 탭을 띄우지 않음", () => {
  const seg = sliceBetween(aiTabs, "function aiTabsOwnedHere", "function reconcileAiTabs", "공유 브라우저 창은 에이전트 탭을 띄우지 않음");
  return /if \(BOUND_SPACE\) return \[\]/.test(seg);
});
check("등록 출처를 남겨 중복을 추적 가능", () => /meta\.win = msg\.win \|\| null/.test(browserMessages) && /BOUND_SPACE \? "shared" : "browser"/.test(webviewFactory));
check("진짜로 닫은 탭만 고정 해제", () => {
  // browser-tab-gone(도킹 전환·프로필 변경으로도 발생)이 아니라 tab.close가 해제 신호여야 한다.
  const seg = sliceFrom(browserMessages, 'm.op === "tab.close"', 300, "진짜로 닫은 탭만 고정 해제");
  return /removeClosedTab\(m\.id\)/.test(seg)
    && /function removeClosedTab\(tabId\)/.test(browserRuntime)
    && /dropPin\(pane, tabId\)/.test(browserRuntime) && /unregTab\(tabId\)/.test(browserRuntime);
});
check("앱 재접속 후에도 같은 탭으로 복귀", () => {
  // 실행기 종료는 wc 결속만 해제한다. 고정을 여기서 비우면 재시작 후 복귀할 수 없다.
  const at = browserRuntime.indexOf("function disconnectCdpExecutor");
  const seg = browserRuntime.slice(at, at + 900);
  return /tabReg\.clear\(\)/.test(seg) && /tabIdByWc\.clear\(\)/.test(seg)
    && !/pinnedTabsByPane\.clear\(\)/.test(seg) && !/dropPin\(/.test(seg);
});
// 렌더러: 보고 있지 않은 스페이스라도 최근에 AI 가 쓴 탭은 살아 있어야 조작이 된다.
// 기준은 하나다. held 와 영구 표식(t.ai)을 함께 보면 두 신호 모두 만료되지 않아,
// 과거에 한 번 쓴 탭이 앱을 켤 때마다 다시 살아난다(저장된 탭 84개 중 24개).
// 지금은 최근 5분 사용 하나로 좁히고, 쓰지 않으면 재우되 다시 쓰면 깨운다.
check("띄우는 기준은 최근 사용 하나 — 쥔 탭·영구 표식으로는 안 되살린다", () => {
  const bareAi = aiTabs.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  return /function reconcileAiTabs/.test(aiTabs) && /reconcileAiTabs\(\);\s+\/\/ 에이전트 탭/.test(aiTabs)
    && /if \(t && protectedIds && protectedIds\.has\(t\.id\)\) out\.push/.test(bareAi)
    && !/t\.ai\s*\|\|/.test(bareAi)
    && !/held\.has\(/.test(bareAi);   // 띄우는 기준과 안 재우는 기준이 갈라지면 만들자마자 재워진다
});
// 서버가 held 를 계속 보내는 것은 그대로다. 그것은 어느 세션이 어느 탭을 쓸 수 있는가(권한)를
// 나타내는 신호이고, 살아 있어야 하는가(수명)와는 다르다. 수명 판정에서만 사용하지 않는다.
check("서버는 여전히 세션이 쥔 탭을 알려준다(권한 신호)", () => {
  const si = readAll("server");
  return /function heldTabsOf\(pane, space\)/.test(si)
    && /out\.push\(\{ pane, label: sessionLabel\(pane\), space, group: sessionGroupId\(pane\), tabId: shown, held \}\)/.test(si)
    && /reconcileAiTabs\(\);   \/\/ 새로 쥔 탭이 생겼으면/.test(web);
});
check("띄우는 창은 하나로 못박음(중복 생성 방지)", () => {
  const seg = sliceBetween(aiTabs, "function aiTabsOwnedHere", "function reconcileAiTabs", "띄우는 창은 하나로 못박음(중복 생성 방지)");
  return /if \(BROWSER_MODE \? docked : !docked\) return \[\]/.test(seg);
});
check("탭의 스페이스 귀속은 서버 상태에서 읽음", () => {
  // "현재 콘솔이 보고 있는 스페이스"로 대체하면 다른 스페이스의 탭이 잘못 등록된다.
  const seg = sliceBetween(webviewFactory, "function reportTabWc", "function forgetTabWc", "탭의 스페이스 귀속은 서버 상태에서 읽음");
  return /function spaceOfTabId/.test(webviewFactory) && /spaceOfTabId\(tabId\) \|\|/.test(seg);
});
check("창 띄우기 요청은 탭당 한 번(포커스 탈취 방지)", () => /aiTabAsked\.has\(x\.id\)/.test(aiTabs) && /aiTabAsked\.add\(x\.id\)/.test(aiTabs));
check("CLI·MCP 양쪽에 노출", () => {
  const cli = read("bin/iris-browser.mjs"), m = read("bin/iris-mcp.mjs");
  return /case "newtab"/.test(cli) && /name: "browser_new_tab"/.test(m)
    && /NO_TAB = new Set\(\["browser_tabs", "browser_target", "browser_new_tab", "browser_report", "browser_trace", "browser_picks", "app_picks"\]\)/.test(m);
});

}

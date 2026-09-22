// 소유 범위: webview LRU 와 조건부 스로틀. 사용하지 않는 webview 는 회수하고 보호 대상은 계속 실행한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/webview-lru.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiState, aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2h2] webview LRU · 조건부 스로틀");
// 기본값은 활성화다. 재우지 않으면 앱을 켜 둔 동안 렌더러가 계속 쌓인다(확인 결과 16개·1.6GB).
check("LRU는 기본으로 켜지고 5분", () =>
  /process\.env\.IRIS_WEBVIEW_LRU !== "0"/.test(main)
  && /return Number\.isFinite\(n\) && n > 0 \? n : 5/.test(main));
check("authoritative AI 상태가 불명확하면 전체 보존", () =>
  /if \(!aiTargetsKnown \|\| !Array\.isArray\(aiTargets\)\) return null/.test(webview)
  && /if \(aiProtected == null\) return true/.test(webview));
// 보호 기준을 최근 5분 사용으로 좁힌 뒤에도 그룹 확장은 유지한다. AI 가 쓴 탭 하나가 속한
// 그룹은 탭 단위 유휴와 무관하게 전체가 백그라운드 작업 단위이기 때문이다. 다만 그 기준이
// held·tab.ai 가 아니라 최근 사용이어야 한다. 기준이 만료되지 않으면 그룹 전체가 만료되지 않는다.
check("최근 쓴 탭의 그룹 전체를 보호하되 씨앗은 최근 사용뿐", () => {
  const seg = /export function authoritativeAiProtection\(\)[\s\S]*?\n\}/.exec(webview);
  if (!seg) throw new Error("authoritativeAiProtection 을 못 찾음");
  return /const ids = aiRecentTabIds\(\)/.test(seg[0])
    && /if \(ids\.has\(tab\.id\) && tab\.group\) groups\.add\(sp \+ "\\n" \+ tab\.group\)/.test(seg[0])
    && /groups\.has\(sp \+ "\\n" \+ tab\.group\)/.test(seg[0])
    && !/tab\.ai/.test(seg[0].replace(/\/\/.*$/gm, ""))
    && !/ids\.add\(String\(target\.tabId\)\)/.test(seg[0]);
});
// 신호를 한 번도 못 받았으면 재우지 않는다. 못 받은 것을 "최근 사용 없음"으로 읽으면 연결이
// 늦은 창이 자기 탭을 전부 재운다.
check("최근 사용 신호를 못 받았으면 전체 보존", () =>
  /if \(!getAiRecentKnown\(\)\) return null/.test(webview)
  && /markAiRecentUnknown\(\);/.test(mainJs));
// 20초 글로우와 5분 수명은 서로 다른 타이머다. 하나로 합치면 글로우가 5분 유지되거나 탭이 20초 만에
// 재워진다. 둘 다 사용자가 바로 알아채는 고장이다.
check("조작 중 글로우와 최근 사용은 다른 시계", () =>
  /const CONTROL_IDLE_MS = 20000;/.test(browserRuntime)
  && /const AI_USE_KEEP_MS = 5 \* 60 \* 1000;/.test(browserRuntime)
  && /aiUseByTab\.set\(tabId, Date\.now\(\) \+ AI_USE_KEEP_MS\)/.test(browserRuntime));
// 만료를 서버 알림에 의존하면 알림이 끊긴 창은 만료되지 않는다.
check("만료 시각을 실어 보내 창이 스스로 식는다", () =>
  /out\.push\(\{ tabId, until \}\)/.test(browserRuntime)
  && /recentAi: aiRecentUse\(\)/.test(browserRuntime)
  && /setAiRecentUse\(m\.recentAi\)/.test(mainJs)
  && /for \(const \[tabId, until\] of aiRecentUntil\) if \(until > t\) out\.add\(tabId\)/.test(aiState));
// 녹화 판정은 "지금 녹화 중인가"가 아니라 "이 탭이 그 녹화의 대상인가"로 좁힌다. 그러지 않으면 무관한
// 탭까지 보호돼 녹화를 켜면 LRU 전체가 멈춘다.
check("활성·녹화·미디어·pinned·최근 탭은 회수 제외", () =>
  /tabId === activeBrowserId\(\) \|\| recTracked\(tabId\) \|\| status\.audible/.test(webview)
  && /stored\.tab\.pinned/.test(webview)
  && /recent && recent\.has\(tabId\)/.test(webview));
check("회수는 wc 등록과 DOM을 실제로 제거", () => {
  const seg = sliceBetween(webview, "function discardWebview", "function wakeWebview", "회수는 wc 등록과 DOM을 실제로 제거");
  return /forgetTabWc\(rec, tabId\)/.test(seg) && /rec\.el\.remove\(\)/.test(seg)
    && /removeWebview\(tabId\)/.test(seg)
    && /export function removeWebview\(tabId\) \{\s*delete browserWv\[tabId\];/.test(webviewStore);
});
check("잠자는 탭은 URL·프로필로 재생성", () => {
  const seg = sliceBetween(webview, "function wakeWebview", "function sweepIdleWebviews", "잠자는 탭은 URL·프로필로 재생성");
  return /spaceDefaultProfile\(stored\.sp\)/.test(seg) && /createWebview\(tabId, profile/.test(seg)
    && /sleeping: false/.test(seg);
});
check("입력·스크롤이 LRU 최근성을 갱신", () => {
  const pre = read("native/electron/webview-preload.cjs");
  return /ac-user-activity/.test(pre) && /addEventListener\("input"/.test(pre)
    && /addEventListener\("scroll"/.test(pre) && /markWebviewUsed\(tabId\)/.test(webviewFactory);
});
check("잠자는 탭 UI 표시", () => /class="csleep"/.test(centerTabs) && /잠자는 탭 · 클릭하면 다시 엽니다/.test(centerTabs));
check("스로틀은 사유별 참조이고 캡처도 보호", () => {
  const { createWebviewThrottle } = require_("../native/electron/webview-throttle.cjs");
  const edges = [];
  const contents = { id: 11, isDestroyed: () => false,
    setBackgroundThrottling: (value) => edges.push(value) };
  const throttle = createWebviewThrottle({ fromId: () => null });
  throttle.setReason(contents, "first", true);
  throttle.setReason(contents, "second", true);
  throttle.setReason(contents, "first", false);
  if (edges.at(-1) !== false) throw new Error("보호 사유 하나를 풀자 나머지 보호까지 풀렸다");
  throttle.setReason(contents, "second", false);
  if (edges.at(-1) !== true) throw new Error("마지막 보호 사유를 풀어도 Chromium 기본값으로 안 돌아간다");

  edges.length = 0;
  throttle.setReason(contents, "same", true);
  throttle.setReason(contents, "same", true);
  throttle.setReason(contents, "same", false);
  if (edges.at(-1) !== true) throw new Error("같은 사유를 두 번 걸어 참조가 중복됐다");

  const popupEdges = [];
  const popup = { id: 12, isDestroyed: () => false,
    setBackgroundThrottling: (value) => popupEdges.push(value) };
  throttle.registerPopup("popup-1", popup);
  throttle.reconcilePopups();
  if (popupEdges.at(-1) !== false) throw new Error("AI 상태 보고가 없는데 popup 보호를 풀었다");
  const sender = { id: 91, once: () => {} };
  throttle.reportRenderer(sender, { webviews: [], protectedTabIds: [], unknownAi: false });
  if (popupEdges.at(-1) !== true) throw new Error("authoritative 빈 보고 뒤에도 popup 보호가 남는다");
  throttle.reportRenderer(sender, { webviews: [], protectedTabIds: [], unknownAi: true });
  if (popupEdges.at(-1) !== false) throw new Error("모르는 AI 상태를 fail-safe로 보호하지 않는다");

  return /setThrottleReason\(guest, "capture", true\)/.test(main)
    && /setWebviewThrottleState/.test(read("native/electron/preload.cjs"));
});
check("롤백 env에서만 Chromium 전역 해제를 적용", () =>
  /process\.env\.IRIS_NO_THROTTLE_OPT === "1"/.test(main)
  && /if \(NO_THROTTLE_OPT\) \{[\s\S]{0,350}disable-renderer-backgrounding/.test(main));


// 앱을 켤 때마다 저장된 탭 전부에 크로미움이 하나씩 실행되던 문제를 막는다. LRU(유휴 회수)는 실행된
// 뒤에 동작하므로 이 급증을 막지 못한다. 처음부터 실행하지 않아야 한다(확인 결과: 저장된 탭 84개·
// 스페이스 14개).
await checkAsync("보고 있는 탭 하나만 실제로 올린다", async () => {
  const mod = await import(new URL("../../../web/js/browser/webview.js", import.meta.url).href);
  const TABLE = [
    ["보고 있는 탭", "a", "a", true, true],
    ["같은 스페이스의 다른 탭", "b", "a", true, false],
    ["활성 탭이 없다", "b", null, true, false],
    ["빈 id", "", "a", true, false],
    ["재우기를 끈 롤백 모드에선 예전처럼 다 만든다", "b", "a", false, true],
  ];
  const wrong = [];
  for (const [name, id, act, lru, want] of TABLE) {
    const got = mod.shouldMaterializeTab(id, act, lru);
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

check("안 올린 탭은 잠자는 탭으로 등록돼 목록에 남는다", () => {
  // 건너뛰기만 하면 탭은 목록에 있어도 눌렀을 때 동작하지 않는다. 깨울 정보(주소·프로필)가
  // 없기 때문이다. 등록해 두어야 wakeWebview 가 그 정보로 복원한다.
  return /shouldMaterializeTab\(t\.id, act, WEBVIEW_LRU\)/.test(dock)
    && /sleepStoredTab\(t\.id, t, sp\)/.test(dock)
    && /export function sleepStoredTab/.test(webview)
    && /recordDiscardedWebview\(tabId, \{ url, profile, discardedAt: 0 \}\)/.test(webview)
    && /setTabStatus\(tabId, \{ sleeping: true, loading: false \}\)/.test(webview);
});

check("한 번도 안 만든 탭을 재울 때 걷어낼 wc·DOM 을 찾지 않는다", () => {
  // discardWebview(회수)와 다른 일이다. 없는 것을 지우려 들면 그 자리에서 예외가 난다.
  const body = /export function sleepStoredTab[\s\S]*?\n\}/.exec(webview);
  if (!body) throw new Error("sleepStoredTab 을 못 찾음");
  return !/forgetTabWc|el\.remove\(\)|removeWebview\(/.test(body[0]);
});
}

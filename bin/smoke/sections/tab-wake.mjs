// 소유 범위: 잠든 탭을 명령이 오면 깨워서 사용하는 경로. 재우기가 자동화를 끊지 않게 하는 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구와 sources 의 공유 소스.
// 유지 조건: 판정을 호출하는 검사와 연결을 확인하는 검사를 함께 둔다. 판정만 맞고 호출하는 곳이
//   없으면 기능이 없는 것과 같고, 연결만 있고 판정이 틀리면 다른 창이 같은 탭을 다시 만든다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/tab-wake.mjs
import { check, checkAsync } from "../core.mjs";
import { aiTabs, browserCommands, browserRuntime, browserExtensionsSource, installAppScript, main as electronMainSource, mainJs, preloadSource, serverIndexSource, webviewLifecycleSource } from "../sources.mjs";

export default async function run() {
console.log("[2h3] 잠든 탭 깨우기");

// 재우기는 메모리를 아끼려는 기능이다. 잠들었다는 이유로 명령을 실패시키면 그 기능이 자동화를
// 중단시킨다.
check("잠든 탭에 명령이 오면 실패시키지 않고 깨워서 다시 태운다", () =>
  /wakeSleepingTab\(asleep\)/.test(browserCommands)
  && /waitForTabWc\(asleep, 12000\)\.then\(\(wc\) => \{[\s\S]{0,400}?runBrowserCmd\(cmd, args, session, true, runId\)/
    .test(browserCommands));

// 깨우지 못한 채 다시 태우면 wc 없는 대상으로 떨어져 "탭이 없다"고 답한다. 탭은 있고 깨우지 못한 것이다.
check("깨우지 못하면 그 사실을 알린다", () =>
  /if \(!wc\) \{\s*resolve\(\{ ok: false, error: `잠든 탭 @[^`]*깨우지 못했습니다/.test(browserCommands));

// 새 탭도 만든 직후에는 활성 탭도 최근 명령 대상도 아니다. 깨우라고 알리지 않으면 사용자가 다른
// 스페이스를 보고 있을 때 아무 창도 띄우지 않아 생성이 시간 초과로 끝난다.
check("새 탭은 만들자마자 깨우라고 알린다", () =>
  /bsMutate\(\{ op: "tab\.open"[\s\S]{0,900}?wakeSleepingTab\(id\);\s*waitForTabWc\(id, 12000\)/.test(browserCommands));

// 잠든 탭은 두 경로로 들어온다. 지목(--tab)이면 tg.tabId 로, 고정·그룹이면 resolveTarget 이
// notReady 를 반환해 tg.waitTab 으로 들어온다. 한쪽만 처리하면 나머지 절반이 실패한다.
check("지목 경로와 고정·그룹 경로를 모두 본다", () =>
  /tg\.tabId && !wcOfTabId\(tg\.tabId\) \? tg\.tabId : \(tg\.notReady \? tg\.waitTab : null\)/
    .test(browserCommands));

// 깨우고 다시 태우는데 그 재진입에서 또 깨우면 요청이 끝나지 않는다.
check("깨우기는 한 번만 돈다", () =>
  /const asleep = noAutoTab \|\| tg\.staleP \|\| tg\.needTab/.test(browserCommands));

// 생성은 창이 담당한다. webview 는 렌더러 소유이고, 어느 창이 소유자인지는 도킹 상태로 갈린다.
check("서버는 알리기만 하고 만들지 않는다", () => {
  const body = /function wakeSleepingTab\(tabId\) \{[\s\S]*?\n\}/.exec(browserRuntime);
  if (!body) throw new Error("wakeSleepingTab 을 못 찾음");
  return /broadcast\(\{ type: "wake-tab", tabId: String\(tabId\) \}\)/.test(body[0])
    && !/createWebview|regTab|tabReg\.set/.test(body[0]);
});

// 방송만 있고 수신부가 없으면 서버는 12초를 기다렸다가 실패한다. 생성 코드가 있어도
// 호출하는 곳이 없으면 동작하지 않는다.
check("창이 그 방송을 받아 실제로 만든다", () =>
  /"wake-tab": dispatchWs\(handleWakeTabMessage\)/.test(mainJs)
  && /function handleWakeTabMessage\(m\) \{[\s\S]{0,200}wakeTabHere\(m\.tabId\)/.test(mainJs)
  && /export function wakeTabHere/.test(aiTabs)
  && /if \(getDiscardedWebview\(tabId\)\) wakeWebview\(tabId\);/.test(aiTabs)
  && /createWebview\(tabId, wantProfile/.test(aiTabs));

// 분리 모드에서 분리 창을 닫으면 docked 는 false 로 남는다. 콘솔은 소유자가 아니라 건너뛰고
// 분리 창은 없어서, 아무도 깨우지 않아 12초 뒤 실패하고 에이전트가 사용자에게 창을 열어 달라고 한다.
// 공유 탭도 같다. 공유 창이 닫혀 있으면 아무도 깨우지 않는다.
check("깨울 창이 없으면 콘솔이 그 탭의 창을 뒤에 띄운다", () => {
  const body = /if \(!wakeOwnedHere\([^\n]*\)\) \{[\s\S]*?return false;\n    \}/.exec(aiTabs);
  if (!body) throw new Error("wakeTabHere 의 소유자 아님 분기를 못 찾음");
  return /if \(!BROWSER_MODE && !BOUND_SPACE\)/.test(body[0])
    && /sp === "__shared__"\) [^\n]*acHost\.openSharedBrowser\(\{ background: true \}\)/.test(body[0])
    && /else if \(!docked && liveSpace\) [^\n]*acHost\.openBrowser\(\{ background: true \}\)/.test(body[0])
    && /openSharedBrowser: \(opts\) => ipcRenderer\.send\("ac-open-shared-browser", opts \|\| null\)/.test(preloadSource)
    && /ipcMain\.on\("ac-open-shared-browser", \(_e, opts\) => \{[^\n]*createBrowserModeWindow\(true, opts\)/.test(electronMainSource);
});

// 창을 닫으면 그 안의 렌더러가 함께 사라져 탭이 사라졌다고 서버에 알리지 못한다. 서버는 죽은 wc 로
// 명령을 보내 "탭을 찾을 수 없음"으로 실패하고, 깨우기 경로에 들어가지 못한다.
// wc 번호만 보낸다. 탭 id 로 해제하면 다른 창에서 새 wc 로 먼저 등록된 탭까지 지운다.
check("webview 가 사라지면 메인이 그 wc 를 서버에 알린다", () =>
  /const goneWc = wc\.id;\s*wc\.once\("destroyed", \(\) => \{ try \{ ctlSend\(\{ type: "browser-tab-gone", wc: goneWc \}\); \} catch \{\} \}\);/
    .test(webviewLifecycleSource)
  && /if \(prev && prev\.wc != null && prev\.wc !== meta\.wc\) tabIdByWc\.delete\(prev\.wc\);/.test(browserRuntime));

// 확장 로드와 겹쳐 출발한 첫 이동은 webRequest 리스너가 있는 확장(Unhook)이 끼면 끝나지 않는다. 그 탭은
// dom-ready 가 오지 않아 서버에 보고되지 않고, 깨우기가 12초 뒤 실패한다(확인 결과: Play 프로필 Cloud 탭).
check("확장 로드 전 프로필의 webview 는 첫 주소를 미뤘다가 로드 뒤에 연다", () =>
  /if \(!\/\^https\?:\/i\.test\(src\) \|\| !needsExtensionWait\(partition\)\) return;\s*params\.src = "";/.test(browserExtensionsSource)
  && /whenRestored\(held\.partition\)\.then\(\(\) => \{[^\n]*\n[^\n]*guest\.loadURL\(held\.src\)/.test(browserExtensionsSource)
  && /result\.then\(\(\) => markRestored\(partition\), \(\) => markRestored\(partition\)\);/.test(browserExtensionsSource));

// 서버의 깨우기는 그 탭의 wc 가 서버에 없다는 뜻이다. 떠 있는 webview 를 그대로 두면 멈춘 탭이 앱을 다시
// 켤 때까지 계속 실패한다(확인 결과: 응답 없는 요청에 걸린 탭이 이후 정상 응답에도 매번 12초 뒤 실패).
check("깨우기는 떠 있는 webview 의 wc 를 다시 보고하거나, 멈춘 것은 새로 만든다", () => {
  const body = /export function wakeTabHere[\s\S]*?\n\}/.exec(aiTabs);
  if (!body) throw new Error("wakeTabHere 를 못 찾음");
  return /if \(live\.ready\) \{ reportTabWc\(live, tabId\); return true; \}/.test(body[0])
    && /if \(Date\.now\(\) - \(live\.createdAt \|\| 0\) < STUCK_WEBVIEW_MS\) return true;\s*discardWebview\(tabId, Date\.now\(\)\);/.test(body[0])
    && /const STUCK_WEBVIEW_MS = (\d+);/.test(aiTabs) && Number(/const STUCK_WEBVIEW_MS = (\d+);/.exec(aiTabs)[1]) < 12000;
});

// 종료 대기가 끝난 직후에 앱이 꺼지면 교체도 재실행도 하지 않은 채 앱이 없는 상태로 남는다.
check("설치 중 교체를 포기하면 꺼진 앱을 다시 연다", () =>
  /앱이 종료되지 않아 교체하지 않습니다[^\n]*\n[\s\S]{0,200}?running \|\| installed_env open -a "\$APP"/.test(installAppScript));

// 뒤늦게 뜬 분리 창은 앞서 보낸 알림을 받지 못했다. 탭 목록보다 먼저 받으면 대상 탭을 찾지 못한다.
check("새로 연결된 창에 대기 중인 깨우기를 탭 목록 뒤에 다시 보낸다", () =>
  /type: "browser-state", state: bsWire\(\) \}\)\);[\s\S]{0,200}?for \(const tabId of pendingWakeTabIds\(\)\) ws\.send\(JSON\.stringify\(\{ type: "wake-tab", tabId \}\)\)/
    .test(serverIndexSource)
  && /function pendingWakeTabIds\(\) \{\s*return \[\.\.\.tabWcWaiters\.keys\(\)\];/.test(browserRuntime));

// 활성 탭만 집계하면 에이전트에게는 자기 탭이 사라진 것으로 보여, 쓰던 탭을 두고 새로 만든다.
check("잠든 탭도 목록에 남는다", () =>
  /sleeping\.push\(\{ tabId: t\.id, handle: handleFor\(t\.id\), space: sp,/.test(browserRuntime)
  && /return \[\.\.\.live, \.\.\.sleeping\]/.test(browserRuntime));

// 잠든 탭은 registry 에 없다. 거기서 "없습니다"로 끊으면 깨우는 경로에 도달하기 전에 실패한다.
// 그렇다고 무조건 통과시키면 다른 그룹의 탭까지 열리므로, 저장된 스페이스를 넣고 같은 규칙을 적용한다.
check("허용 판정은 잠든 탭에도 같은 규칙을 태운다", () => {
  const body = /function tabAllowed\(session, tabId\) \{[\s\S]*?\n\}/.exec(browserRuntime);
  if (!body) throw new Error("tabAllowed 를 못 찾음");
  return /hasStoredTab\(tabId\) \? \{ space: storageSpaceOfTab\(tabId\), sleeping: true \}/.test(body[0])
    && /sameStorageSpace\(meta\.space, mine\)/.test(body[0])
    && !/sleeping[\s\S]{0,40}return \{ ok: true \}/.test(body[0]);
});

// 조건을 넓히면 같은 탭에 webview 가 둘 생기고 wc 가 겹친다. 확인된 고장이다.
await checkAsync("깨울 자격은 지금 webview 를 쥔 창 하나뿐", async () => {
  const mod = await import(new URL("../../../web/js/browser/ai-tabs.js", import.meta.url).href);
  const base = { boundSpace: null, browserMode: false, docked: false, sp: "w1", liveSpace: true };
  const TABLE = [
    ["콘솔에 도킹돼 있으면 콘솔이 쥔다", { docked: true }, true],
    ["공유 창은 주인이 아니다", { boundSpace: "__shared__", docked: true }, false],
    ["콘솔인데 분리돼 있다", { docked: false }, false],
    ["분리 창인데 도킹돼 있다", { browserMode: true, docked: true }, false],
    ["분리 창이 쥐고 있다", { browserMode: true, docked: false }, true],
    ["공유 탭은 공유 창 몫", { sp: "__shared__", docked: true }, false],
    ["공유 창이 공유 탭을 깨운다", { boundSpace: "__shared__", browserMode: true, sp: "__shared__", docked: true }, true],
    ["분리 상태여도 공유 탭은 공유 창이 깨운다", { boundSpace: "__shared__", browserMode: true, sp: "__shared__", docked: false }, true],
    ["분리 창은 공유 탭을 깨우지 않는다", { browserMode: true, sp: "__shared__", docked: false }, false],
    ["접은 스페이스는 안 되살린다", { liveSpace: false, docked: true }, false],
  ];
  const wrong = [];
  for (const [name, over, want] of TABLE) {
    const got = mod.wakeOwnedHere({ ...base, ...over });
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});
}

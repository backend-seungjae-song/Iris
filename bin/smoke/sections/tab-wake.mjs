// 소유 범위: 잠든 탭을 명령이 오면 깨워서 사용하는 경로. 재우기가 자동화를 끊지 않게 하는 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구와 sources 의 공유 소스.
// 유지 조건: 판정을 호출하는 검사와 연결을 확인하는 검사를 함께 둔다. 판정만 맞고 호출하는 곳이
//   없으면 기능이 없는 것과 같고, 연결만 있고 판정이 틀리면 다른 창이 같은 탭을 다시 만든다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/tab-wake.mjs
import { check, checkAsync } from "../core.mjs";
import { aiTabs, browserCommands, browserRuntime, mainJs } from "../sources.mjs";

export default async function run() {
console.log("[2h3] 잠든 탭 깨우기");

// 재우기는 메모리를 아끼려는 기능이다. 잠들었다는 이유로 명령을 실패시키면 그 기능이 자동화를
// 중단시킨다.
check("잠든 탭에 명령이 오면 실패시키지 않고 깨워서 다시 태운다", () =>
  /wakeSleepingTab\(asleep\)/.test(browserCommands)
  && /waitForTabWc\(asleep, 12000\)\.then\(\(\) => \{ runBrowserCmd\(cmd, args, session, true, runId\)/
    .test(browserCommands));

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

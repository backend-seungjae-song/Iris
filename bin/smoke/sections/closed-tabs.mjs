// 소유 범위: 닫은 탭 되돌리기(⌘⇧T). 복원에 필요한 정보를 저장하는 시점과 무엇을 복원할지 고르는 판정.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구와 sources 의 공유 소스.
// 유지 조건: 판정을 부르는 검사와 연결을 확인하는 검사를 함께 둔다. 저장 시점이 빠지면 판정이
//   맞아도 복원할 정보가 없고, 연결이 빠지면 키를 눌러도 아무 일도 일어나지 않는다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/closed-tabs.mjs
import { check, checkAsync, read } from "../core.mjs";
import { browserMessages, dock, mainJs, mainWindowSource } from "../sources.mjs";

export default async function run() {
console.log("[2h4] 닫은 탭 되돌리기");

const runtime = read("server/browser-runtime.js");
const keynav = read("web/js/core/keynav.js");
const tabClose = read("web/js/center/tab-close.js");
const closedTabs = read("web/js/center/closed-tabs.js");

// 복원 정보를 저장할 수 있는 시점은 bsMutate 호출 전뿐이다. 그 뒤에는 주소·프로필·그룹이
// 상태에서 사라져서 무엇을 열어야 할지 알 수 없다.
check("닫히기 전에 재료를 남긴다", () => {
  const seg = /export function handleBrowserSync[\s\S]*?\n\}/.exec(browserMessages);
  if (!seg) throw new Error("handleBrowserSync 를 못 찾음");
  const at = seg[0].indexOf("recordClosedTab("), mut = seg[0].indexOf("bsMutate(mutation)");
  return at > 0 && mut > 0 && at < mut;
});

// 복원한 항목을 스택에서 빼지 않으면 두 번 눌러도 같은 탭만 열려서 그 앞 탭에는 도달할 수 없다.
check("되살리면 스택에서 뺀다", () =>
  /function takeClosedTab\(tabId\) \{[\s\S]{0,300}closedTabs\.splice\(i, 1\)\[0\]/.test(runtime)
  && /const entry = takeClosedTab\(/.test(browserMessages));

// 값이 없는 profile 키를 함께 보내면 tab.open 전체가 거부되어 복원이 실패한다.
check("되살릴 때 빈 profile 키를 싣지 않는다", () =>
  /if \(entry\.profile != null\) mutation\.profile = entry\.profile;/.test(browserMessages));

// 스택 길이를 제한하지 않으면 오래된 항목이 메모리에 남고 목록 표시도 길어진다.
check("스택 깊이가 묶여 있다", () =>
  /const CLOSED_TAB_KEEP = 25;/.test(runtime)
  && /while \(closedTabs\.length > CLOSED_TAB_KEEP\) closedTabs\.shift\(\)/.test(runtime));

// 서버에도 보내고 창에서도 집계하면 한 번 닫은 탭이 두 항목이 되어, 두 번째 ⌘⇧T 가 의도한 탭을 복원하지 못한다.
check("서버가 세는 탭을 창이 또 세지 않는다", () => {
  const at = tabClose.indexOf('if (String(current.id).startsWith("browser:")');
  if (at < 0) throw new Error("닫기 분기를 못 찾음");
  const seg = [tabClose.slice(at, at + 700)];
  return /\} else \{[\s\S]{0,400}noteClosedCenterTab\(target\.space, current\)/.test(seg[0]);
});

// 창마다 따로 집계하면 분리 창에서 닫은 탭을 콘솔에서 복원할 수 없다.
check("브라우저 탭 스택은 서버가 정본", () =>
  /function closedTabsWire\(\)[\s\S]{0,300}closedTabs\.map\(\(\{ navigationHistory, \.\.\.entry \}\) => entry\)/.test(runtime)
  && /"closed-tabs": dispatchWs\(handleClosedTabsMessage\)/.test(mainJs)
  && /setClosedBrowserTabs\(m\.tabs\)/.test(mainJs)
  && /wsSend && wsSend\(\{ type: "tab-reopen", tabId: pick\.entry\.tabId \}\)/.test(closedTabs));

// pageState 에는 폼 값이 들어갈 수 있다. 일반 broadcast 나 재접속 초기 목록에 섞이면 원격 UI 까지
// 전달되므로, 닫힌 목록에서는 제외하고 실제 복원 직전에 로컬 창에만 먼저 보낸다.
check("탐색 이력은 로컬에만 state보다 먼저 보낸다", () => {
  const seg = /export function handleTabReopen[\s\S]*?\n\}/.exec(browserMessages)?.[0] || "";
  const history = seg.indexOf('broadcastLocal({\n      type: "tab-reopen-history"');
  const state = seg.indexOf('broadcast({ type: "browser-state"');
  return /recordClosedTab\(m\.id, m\.navigationHistory\)/.test(browserMessages)
    && history > 0 && state > history
    && /"tab-reopen-history": dispatchWs\(handleTabReopenHistoryMessage\)/.test(mainJs);
});

// 호스트 포커스, webview 포커스, 중계를 받는 표 세 곳이 모두 연결되어야 키가 실제로 동작한다.
check("⌘⇧T 가 세 자리에서 같은 곳으로 간다", () =>
  /matchBinding\(e, bindingOf\("reopen-tab"\)\)[\s\S]{0,80}reopenLastClosed\(\)/.test(keynav)
  && /"reopen-tab": \{ mod: true, shift: true, key: "t" \}/.test(mainWindowSource)
  && /case "reopen-tab": reopenLastClosed\(\)/.test(dock));

// ⌘⇧T 를 탭 생성 분기가 먼저 처리하면 복원 대신 빈 탭이 열린다.
check("탭 생성보다 먼저 판정한다", () => {
  const re = keynav.indexOf('bindingOf("reopen-tab")');
  const cr = keynav.indexOf('const create = matchBinding(e, bindingOf("new-tab"))');
  return re > 0 && cr > 0 && re < cr;
});

// 서버는 센터 탭을 모르고 센터 탭 스택도 서버에 없으므로, 어느 쪽이 더 최근인지는 창에서만 판단할 수 있다.
await checkAsync("더 최근에 닫힌 쪽을 고른다", async () => {
  const mod = await import(new URL("../../../web/js/center/closed-tabs.js", import.meta.url).href);
  const B = (t) => ({ tabId: "b" + t, closedAt: t });
  const C = (t) => ({ path: "/p" + t, closedAt: t });
  const TABLE = [
    ["둘 다 없다", [], [], null],
    ["브라우저만", [B(10)], [], "browser"],
    ["센터만", [], [C(10)], "center"],
    ["센터가 더 최근", [B(10)], [C(20)], "center"],
    ["브라우저가 더 최근", [B(30)], [C(20)], "browser"],
    ["같은 시각이면 브라우저", [B(10)], [C(10)], "browser"],
    ["맨 위만 본다(앞엣것에 안 속는다)", [B(1), B(5)], [C(3)], "browser"],
  ];
  const wrong = [];
  for (const [name, b, c, want] of TABLE) {
    const got = mod.pickReopen(b, c);
    const kind = got ? got.kind : null;
    if (kind !== want) wrong.push(name + ": " + kind + " (기대 " + want + ")");
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

// 경로 없는 탭을 스택에 넣으면 ⌘⇧T 한 번이 아무 일도 하지 않으면서 그 앞의 복원 가능한 탭을 소비한다.
await checkAsync("되살릴 수 없는 것은 스택에 안 넣는다", async () => {
  const mod = await import(new URL("../../../web/js/center/closed-tabs.js", import.meta.url).href);
  const TABLE = [
    ["경로 있는 파일 탭", "w1", { path: "/a.txt" }, true],
    ["경로 없는 탭", "w1", { label: "무제" }, false],
    ["탭이 없다", "w1", null, false],
    ["스페이스가 없다", null, { path: "/a.txt" }, false],
  ];
  const wrong = [];
  for (const [name, sp, tab, want] of TABLE) {
    const got = mod.noteClosedCenterTab(sp, tab);
    if (got !== want) wrong.push(name + ": " + got + " (기대 " + want + ")");
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

await checkAsync("복원 이력은 한 번만 꺼내고 만료시킨다", async () => {
  const mod = await import(new URL("../../../web/js/center/closed-tabs.js", import.meta.url).href);
  const history = { entries: [{ url: "https://a.test/" }, { url: "https://b.test/" }], index: 0 };
  if (!mod.queueReopenedBrowserHistory({ tabId: "browser:history", history }, 100)) return false;
  if (mod.takeReopenedBrowserHistory("browser:history", 101) !== history) return false;
  if (mod.takeReopenedBrowserHistory("browser:history", 102) !== null) return false;
  if (!mod.queueReopenedBrowserHistory({ tabId: "browser:expired", history }, 100)) return false;
  return mod.takeReopenedBrowserHistory("browser:expired", 30_101) === null;
});
}

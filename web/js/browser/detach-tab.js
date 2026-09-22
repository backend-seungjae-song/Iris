// 탭 분리. 탭 하나를 자기 창으로 빼낸다(크롬의 탭 끌어내기와 같은 동작).
//
// 소유 범위
//   지금 떨어져 있는 탭 id 집합, 탭 우클릭의 "창으로 빼기" 줄, 분리 창의 되돌리기 연결.
//   창 자체는 네이티브(detached-tab-window.cjs)가 소유하고, 여기는 호출하고 결과를 받기만 한다.
//
// 제공 API
//   initCapability(ctx). 그리고 훅을 채운다: detach.tabItem · detach.stripReady · detach.hidden ·
//   detach.boundTab.
//   브라우저 코어는 이 이름만 알고, 이 기능을 끄면 그 지점은 아무 일도 하지 않는다.
//
// 의존 대상
//   ctx 의 acHost(네이티브 연결) · boundTab(주소의 tab 값) · redrawBrowser(화면 갱신) ·
//   bsMutate 는 쓰지 않는다. 이 기능은 탭 기록을 바꾸지 않는다.
//
// 유지 조건
//   떨어진 탭은 옮긴 것이 아니라 감춘 것이다. 탭 기록은 그대로 두고 띠에서만 뺀다. 그래서
//   분리 창을 닫으면 탭이 사라지지 않고 원래 위치로 돌아온다. 창을 닫아 탭을 잃는
//   경로를 만들지 않는다.
//   목록은 네이티브가 정본이다. 여기서 낙관적으로 먼저 감추지 않는다. 창이 실제로 떴을 때만
//   감춰야 창이 뜨지 않은 경우에 탭이 어디에도 없는 상태가 생기지 않는다.
//   분리 창(boundTab 이 있는 창)에서는 이 훅들이 띠를 건드리지 않는다. 그 창의 띠는 자기 탭
//   하나만 그리고, 그것마저 감추면 빈 창이 된다.
//
// 영향 범위
//   공급자는 core/capabilities 의 load 와 main 이 넘기는 ctx 다. 소비자는 browser/tabs.js 의
//   탭 우클릭·띠 그리기와 네이티브의 ac-detached-tabs 방송이다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/detach-tab.js
import { provide } from "../core/hooks.js";
import { wireTabDrag, reportStripRect } from "./tab-drag.js";

let host = null;          // acHost
let boundTab = null;      // 이 창이 한 탭에 묶여 있으면 그 id
let redraw = () => {};
let notify = () => {};
let detached = new Set(); // 네이티브가 말해 준 것만 담는다

function setDetached(list) {
  const next = new Set((list || []).map((x) => String(x && x.tabId || "")).filter(Boolean));
  let same = next.size === detached.size;
  if (same) for (const id of next) if (!detached.has(id)) { same = false; break; }
  if (same) return;
  detached = next;
  redraw();
}

async function detach(tabId, title, space) {
  if (!host || !host.detachTab) return;
  const r = await host.detachTab({ tabId, title, space });
  if (!r || !r.ok) notify(r && r.error ? `탭을 빼지 못했습니다: ${r.error}` : "탭을 빼지 못했습니다");
  // 감추는 것은 방송을 받은 뒤다. 미리 감추면 창이 뜨지 않았을 때 탭이 어디에도 없게 된다.
}

export function initCapability(ctx) {
  host = ctx.acHost || null;
  boundTab = ctx.boundTab || null;
  // 띠만 다시 그리는 것으로는 부족하다. 분리 목록이 바뀌면 이 창이 표시할 탭도 바뀐다.
  redraw = typeof ctx.redrawBrowser === "function" ? ctx.redrawBrowser : () => {};
  notify = typeof ctx.showToast === "function" ? ctx.showToast : () => {};

  // 탭 우클릭 한 줄. 분리 창 안에서는 뺄 곳이 없으므로 그 줄을 만들지 않는다.
  provide("detach.tabItem", (tab, space) => {
    if (!host || !host.detachTab) return null;
    if (boundTab) return null;
    if (!tab || !tab.id) return null;
    return {
      label: "창으로 빼기",
      act: () => detach(tab.id, tab.name || tab.title || "", space),
    };
  });

  // 띠가 감출 탭. 분리 창은 자기 탭 하나만 그리므로 감추지 않는다.
  provide("detach.hidden", () => (boundTab ? null : detached));

  // 이 창이 한 탭에 묶여 있는가. 묶여 있으면 그 id.
  provide("detach.boundTab", () => boundTab);

  // 띠 하나를 크롬과 같은 방식으로 연결한다. 코어는 이 이름만 알고, 이 기능을 끄면 코어가
  // 기본 방식(위치 이동만)으로 동작한다.
  provide("detach.stripReady", (strip, api) => {
    wireTabDrag({ strip, ...api });
    // 띠가 다시 그려질 때마다 화면 어디에 있는지 알린다. main 은 이 사각형으로만 판정한다.
    // 창 크기로 추정하면 띠가 없는 창에도 붙는다.
    reportStripRect(strip, { space: api && api.spaceOf ? api.spaceOf() : "", tab: boundTab || "" });
    return true;
  });

  // 되돌리는 훅은 두지 않는다. 호출하는 곳이 없는 이름을 열어 두면 사용할 수 있다는 잘못된 표시가
  // 남고, 검사가 이를 막는다. 되돌리는 경로는 둘이며 모두 이 파일 밖에 있다. 다른 창의 띠로 끌어다
  // 놓거나, 그 창을 닫는 것이다. 창을 닫으면 네이티브가 목록에서 빼고 방송한다.

  if (host && host.onDetachedTabs) host.onDetachedTabs(setDetached);
  // 늦게 뜬 창은 방송을 받지 못했으므로, 현재 상태를 한 번 조회해 맞춘다.
  if (host && host.detachedTabs) {
    Promise.resolve(host.detachedTabs()).then((r) => setDetached(r && r.tabs)).catch(() => {});
  }
  return {};
}

// 탭 분리. 탭을 띠에서 빼내 자기 창으로 옮긴다(크롬의 탭 끌어내기와 같은 동작). 분리 창도 탭 띠가
// 있는 브라우저 창이라 그 안에서 새 탭을 만들고 고를 수 있다. 창은 스페이스에만 속한다.
//
// 소유 범위
//   지금 떨어져 있는 탭 id 집합, 이 창이 분리 창이면 그 창의 탭 목록과 고른 탭, 탭 우클릭의
//   "창으로 빼기" 줄. 창 자체는 네이티브(detached-tab-window.cjs)가 소유하고 여기는 호출과 수신만 한다.
//
// 제공 API
//   initCapability(ctx). 그리고 훅을 채운다: detach.tabItem · detach.stripReady · detach.hidden ·
//   detach.boundTab · detach.ownTabs · detach.select · detach.claim · detach.sync.
//   브라우저 코어는 이 이름만 알고, 이 기능을 끄면 그 지점은 아무 일도 하지 않는다.
//
// 의존 대상
//   ctx 의 acHost(네이티브 연결) · detachedWin(주소의 win 값) · boundTab(주소의 tab 값, 처음 고른 탭) ·
//   redrawBrowser(화면 갱신). 이 기능은 탭 기록을 바꾸지 않는다.
//
// 유지 조건
//   떨어진 탭은 옮긴 것이 아니라 감춘 것이다. 탭 기록은 그대로 두고 띠에서만 뺀다. 그래서
//   분리 창을 닫으면 그 창의 탭이 사라지지 않고 원래 위치로 돌아온다.
//   목록은 네이티브가 정본이다. 여기서 낙관적으로 먼저 감추지 않는다. 창이 실제로 떴을 때만
//   감춰야 창이 뜨지 않은 경우에 탭이 어디에도 없는 상태가 생기지 않는다.
//   분리 창의 고른 탭은 그 창만의 값이다. 스페이스의 공유 활성 탭을 쓰면 원래 창이 감춰진 탭으로 끌려간다.
//
// 영향 범위
//   공급자는 core/capabilities 의 load 와 main 이 넘기는 ctx 다. 소비자는 browser/tabs.js 의
//   탭 우클릭·띠 그리기, browser/webview.js·dock.js 의 활성 탭 판정, main.js 의 새 탭, keynav 의
//   탭 순환과 네이티브의 ac-detached-tabs 방송이다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/detach-tab.js
import { provide } from "../core/hooks.js";
import { wireTabDrag, reportStripRect } from "./tab-drag.js";

let host = null;          // acHost
let myWin = null;         // 이 창이 분리 창이면 그 창 id
let picked = null;        // 분리 창에서 고른 탭
let order = [];           // 분리 창의 탭 id, 띠에 그린 순서
let redraw = () => {};
let notify = () => {};
let detached = new Set(); // 네이티브가 말해 준 것만 담는다
let own = new Set();      // 이 분리 창에 속한 탭
const seen = new Set();   // 분리 창 띠에 한 번이라도 그린 탭

function setDetached(list) {
  const items = (list || []).filter((x) => x && x.tabId);
  const next = new Set(items.map((x) => String(x.tabId)));
  const nextOwn = new Set(myWin ? items.filter((x) => x.win === myWin).map((x) => String(x.tabId)) : []);
  const same = (a, b) => a.size === b.size && [...a].every((id) => b.has(id));
  if (same(next, detached) && same(nextOwn, own)) return;
  const hadOwn = own.size > 0;
  detached = next; own = nextOwn;
  // 이 창의 탭이 모두 다른 곳으로 갔으면 창도 닫는다. 네이티브도 빈 창을 닫지만, 렌더러가 먼저 알면 빈 화면이 보이지 않는다.
  if (myWin && hadOwn && !own.size) { try { window.close(); } catch {} return; }
  redraw();
}

// 분리 창이 지금 보여 줄 탭. 고른 탭이 빠졌으면 그 자리의 이웃.
function shownTab() {
  if (!myWin) return null;
  if (picked && own.has(picked)) return picked;
  const at = order.indexOf(picked);
  const live = order.filter((id) => own.has(id));
  if (!live.length) return [...own][0] || null;
  if (at < 0) return (picked = live[0]);
  for (let i = at + 1; i < order.length; i++) if (own.has(order[i])) return (picked = order[i]);
  for (let i = at - 1; i >= 0; i--) if (own.has(order[i])) return (picked = order[i]);
  return (picked = live[0]);
}

async function detach(tabId, title, space) {
  if (!host || !host.detachTab) return;
  const r = await host.detachTab({ tabId, title, space });
  if (!r || !r.ok) notify(r && r.error ? `탭을 빼지 못했습니다: ${r.error}` : "탭을 빼지 못했습니다");
  // 감추는 것은 방송을 받은 뒤다. 미리 감추면 창이 뜨지 않았을 때 탭이 어디에도 없게 된다.
}

export function initCapability(ctx) {
  host = ctx.acHost || null;
  myWin = ctx.detachedWin || null;
  picked = ctx.boundTab || null;
  if (myWin && picked) own = new Set([picked]);
  // 띠만 다시 그리는 것으로는 부족하다. 분리 목록이 바뀌면 이 창이 표시할 탭도 바뀐다.
  redraw = typeof ctx.redrawBrowser === "function" ? ctx.redrawBrowser : () => {};
  notify = typeof ctx.showToast === "function" ? ctx.showToast : () => {};

  // 탭 우클릭 한 줄. 분리 창에서는 탭이 둘 이상일 때만(하나뿐이면 이미 그 탭의 창이다).
  provide("detach.tabItem", (tab, space) => {
    if (!host || !host.detachTab) return null;
    if (!tab || !tab.id) return null;
    if (myWin && own.size < 2) return null;
    return {
      label: myWin ? "새 창으로 빼기" : "창으로 빼기",
      act: () => detach(tab.id, tab.name || tab.title || "", space),
    };
  });

  // 띠가 감출 탭. 분리 창은 자기 탭만 그리므로 ownTabs 를 쓴다.
  provide("detach.hidden", () => (myWin ? null : detached));

  // 분리 창이면 그 창에 속한 탭.
  provide("detach.ownTabs", () => (myWin ? own : null));

  // 분리 창이 지금 보여 주는 탭. 분리 창이 아니면 null.
  provide("detach.boundTab", () => shownTab());

  // 분리 창에서 탭을 고른다. 처리했으면 true. 분리 창이 아니면 공유 활성 탭을 옮기는 기본 동작을 쓴다.
  provide("detach.select", (id) => {
    if (!myWin || !own.has(id)) return false;
    if (picked !== id) { picked = id; redraw(); }
    return true;
  });

  // 이 분리 창에서 새 탭을 만들기 전에 그 id 를 창에 등록한다. 등록이 먼저여야 다른 창이 그 탭을
  // 한순간이라도 자기 탭으로 그리지 않는다. 분리 창이 아니면 null.
  provide("detach.claim", (tabId, space) => {
    if (!myWin || !host || !host.claimDetachedTab) return null;
    own.add(tabId); picked = tabId;
    return Promise.resolve(host.claimDetachedTab({ win: myWin, tabId, space })).catch(() => null);
  });

  // 띠를 그릴 때 스페이스의 탭 순서를 받는다. 분리 창에서 닫힌 탭은 네이티브 목록에서도 뺀다.
  // 한 번이라도 목록에 있었던 탭만 뺀다. 방금 등록한 새 탭은 서버 방송이 오기 전까지 목록에 없다.
  provide("detach.sync", (ids) => {
    if (!myWin) return;
    const live = new Set(ids);
    order = ids.filter((id) => own.has(id));
    for (const id of order) seen.add(id);
    for (const id of [...own]) if (seen.has(id) && !live.has(id) && host && host.reattachTab) { seen.delete(id); host.reattachTab(id); }
  });

  // 띠 하나를 크롬과 같은 방식으로 연결한다. 코어는 이 이름만 알고, 이 기능을 끄면 코어가
  // 기본 방식(위치 이동만)으로 동작한다.
  provide("detach.stripReady", (strip, api) => {
    wireTabDrag({ strip, ...api });
    // 띠가 다시 그려질 때마다 화면 어디에 있는지 알린다. main 은 이 사각형으로만 판정한다.
    // 창 크기로 추정하면 띠가 없는 창에도 붙는다. win 이 있으면 그 띠에 놓은 탭은 이 분리 창으로 온다.
    reportStripRect(strip, { space: api && api.spaceOf ? api.spaceOf() : "", win: myWin || "" });
    return true;
  });

  // 되돌리는 경로는 둘이며 모두 이 파일 밖에 있다. 다른 창의 띠로 끌어다 놓거나, 그 창을 닫는 것이다.
  // 창을 닫으면 네이티브가 그 창의 탭을 목록에서 빼고 방송한다.

  if (host && host.onDetachedTabs) host.onDetachedTabs(setDetached);
  // 늦게 뜬 창은 방송을 받지 못했으므로, 현재 상태를 한 번 조회해 맞춘다.
  if (host && host.detachedTabs) {
    Promise.resolve(host.detachedTabs()).then((r) => setDetached(r && r.tabs)).catch(() => {});
  }
  return {};
}

// 탭 끌기(렌더러 쪽). 크롬의 TabDragController 와 같은 방식이다.
//
// 소유 범위
//   띠 사각형을 화면 좌표로 알리는 일, 포인터로 탭을 끄는 동안의 커서 좌표 보내기,
//   그리고 띠 안에서 끄는 동안의 위치 미리보기(어디에 놓일지).
//
// 제공 API
//   wireTabDrag({ strip, tabSel, keyOf, titleOf, spaceOf, move }). 띠 하나에 연결한다.
//   stopTabDrag(). 끌기를 중간에 중단한다.
//
// 의존 대상
//   window.acHost 의 연결 넷(tabStripRect · tabDragStart · tabDragMove · tabDragEnd).
//   그것이 없으면 아무것도 하지 않는다. 브라우저에서 그냥 열었을 때 오류가 나지 않아야 한다.
//
// 유지 조건
//   분리·결합의 판정은 여기가 하지 않는다. main 이 창들의 띠 사각형을 다 알고 크롬과 같은 식
//   으로 정한다. 렌더러는 자기 창 밖을 볼 수 없기 때문이다. 여기서 다시 구현하면 두 판정이 갈린다.
//   놓을 때 분리하지 않는다. 크롬은 경계를 넘는 순간 옮긴다(ContinueDragging). 놓기는 끝낼 뿐이다.
//   HTML5 드래그앤드롭을 쓰지 않는다. 그 방식은 창 밖 좌표를 주지 않고 창을 옮길 수도 없다.
//   그래서 "밖에 놓으면 새 창"이 되어 크롬과 다르게 동작한다.
//   문턱을 넘기 전에는 아무 일도 없다. 누르기만 해도 끌린 것으로 판정하면 탭을 누를 수 없다.
//
// 영향 범위
//   짝은 native/electron/tab-drag.cjs 다. 띠를 그리는 쪽은 browser/tabs.js 이고, 이 모듈은
//   그 띠의 DOM 이름을 모른다. 선택자와 키 추출 방법을 연결할 때 받는다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/tab-drag.js

// 누른 채 이만큼 움직여야 끌기로 본다. 크롬도 같은 성격의 문턱을 둔다(MaybeStartDrag).
const START_THRESHOLD = 5;

let active = null;   // 지금 끌고 있는 것
let host = null;

function bridge() {
  if (host) return host;
  host = (typeof window !== "undefined" && window.acHost) || null;
  return host;
}

// 띠가 창 안 어디에 있는지. 화면 좌표로 보내지 않는다. 그 값은 창을 옮기는 순간 최신이 아니고,
// 옮긴 창은 다시 그리지 않으므로 갱신되지 않는다. 창의 위치는 main 이 항상 알고 있으니
// 거기에 이 상대 좌표를 더하게 한다.
export function reportStripRect(strip, meta) {
  const h = bridge();
  if (!h || !h.tabStripRect) return;
  if (!strip || !strip.isConnected) { h.tabStripRect(null); return; }
  const r = strip.getBoundingClientRect();
  if (!r.width || !r.height) { h.tabStripRect(null); return; }
  h.tabStripRect({
    left: Math.round(r.left), top: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    space: (meta && meta.space) || "", tab: (meta && meta.tab) || "",
  });
  // 창 크기가 바뀌면 띠 너비도 바뀐다. 한 번만 걸어 둔다.
  if (!strip.__rectWatch) {
    strip.__rectWatch = true;
    window.addEventListener("resize", () => reportStripRect(strip, meta));
  }
}

export function stopTabDrag() {
  if (!active) return;
  const el = active.el;
  if (el) el.classList.remove("dragging");
  active = null;
  const h = bridge();
  if (h && h.tabDragEnd) Promise.resolve(h.tabDragEnd()).catch(() => {});
}

export function wireTabDrag({ strip, tabSel, keyOf, titleOf, spaceOf, move }) {
  const h = bridge();
  if (!strip || strip.__tabdrag) return;
  strip.__tabdrag = true;
  if (!h || !h.tabDragStart) return;   // 다리가 없으면 아무것도 걸지 않는다

  // 칩에는 draggable="true" 가 붙어 있다(기존 방식이 쓰던 것). 그대로 두면 누르고 움직이는
  // 순간 브라우저가 네이티브 드래그를 시작하고 포인터 이벤트가 취소된다. 그러면 이 경로는
  // 문턱을 넘지 못해 분리가 동작하지 않는다(확인 결과).
  // 속성을 지우지 않고 시작만 막는다. 지우면 매 렌더마다 다시 지워야 하고, 기능을 껐을 때
  // 기존 방식을 쓸 수 없게 된다.
  strip.addEventListener("dragstart", (e) => e.preventDefault());

  const clear = () => strip.querySelectorAll(".drop-before,.drop-after")
    .forEach((n) => n.classList.remove("drop-before", "drop-after"));

  // 포인터 캡처를 쓰지 않는다. 캡처를 걸면 그 뒤의 click 대상이 띠 자신이 되어, 탭을 눌러
  // 여는 경로가 동작하지 않는다(띠의 클릭 연결은 e.target.closest(".ctab") 로 찾는다).
  // 대신 끄는 동안만 창에 리스너를 건다. 띠 밖으로 나가도 좌표가 계속 온다.
  let onMove = null, onUp = null;

  const detachWindowListeners = () => {
    if (onMove) window.removeEventListener("pointermove", onMove, true);
    if (onUp) { window.removeEventListener("pointerup", onUp, true); window.removeEventListener("pointercancel", onUp, true); }
    onMove = null; onUp = null;
  };

  // 끌던 창이 포커스를 잃으면 마우스가 더 안 온다. 그 상태로 두면 다음에 이 창을 누를 때
  // 멈춰 있던 끌기가 다시 시작된다. 누르지 않은 탭이 끌리게 된다.
  window.addEventListener("blur", () => {
    if (!active) return;
    stopTabDrag();
    detachWindowListeners();
  });

  strip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // 앞의 끌기가 남아 있으면 먼저 끝낸다. 남은 것 위에 새로 얹으면 리스너가 겹친다.
    if (active) { stopTabDrag(); detachWindowListeners(); }
    const el = e.target.closest(tabSel);
    if (!el) return;
    // 닫기 단추를 누른 것은 끌기가 아니다.
    if (e.target.closest("[data-close]")) return;
    const key = keyOf(el);
    if (!key) return;
    const r = el.getBoundingClientRect();
    active = {
      el, key, started: false,
      downX: e.clientX, downY: e.clientY,
      // 잡은 위치를 창 안에서도 유지한다. 이것이 없으면 떼어낸 창이 커서 왼쪽 위로 이동한다.
      grabDx: Math.round(e.clientX - r.left), grabDy: Math.round(e.clientY - r.top),
      before: null, hasTarget: false, inFlight: false,
    };

    onMove = (ev) => {
      if (!active) return;
      if (!active.started) {
        const far = Math.abs(ev.clientX - active.downX) > START_THRESHOLD
          || Math.abs(ev.clientY - active.downY) > START_THRESHOLD;
        if (!far) return;
        active.started = true;
        active.el.classList.add("dragging");
        Promise.resolve(h.tabDragStart({
          tabId: active.key, space: spaceOf(), title: titleOf(active.key),
          grabDx: active.grabDx, grabDy: active.grabDy,
        })).catch(() => {});
      }
      // 커서는 화면 좌표로 보낸다. main 은 창 밖의 띠도 봐야 한다.
      // 앞 것이 아직 안 돌아왔으면 보내지 않는다. 마우스는 초당 수십 번 움직여서, 그대로 던지면
      // 창을 옮기는 일이 밀려 커서보다 늦게 따라온다.
      if (!active.inFlight) {
        active.inFlight = true;
        Promise.resolve(h.tabDragMove({
          x: Math.round(window.screenX + ev.clientX), y: Math.round(window.screenY + ev.clientY),
        })).catch(() => {}).then(() => { if (active) active.inFlight = false; });
      }

      // 띠 안에서 끄는 동안의 위치 미리보기. 어디에 놓일지는 이 창이 안다.
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const overTab = over && over.closest ? over.closest(tabSel) : null;
      clear();
      // 가리킨 탭이 없으면 "어디로" 가 없는 것이다. before=null 을 그대로 두면 맨 뒤로 옮기는
      // 뜻이 되어, 빈 영역에 놓기만 해도 순서가 바뀐다.
      active.before = null;
      active.hasTarget = false;
      if (overTab && overTab !== active.el) {
        const rr = overTab.getBoundingClientRect();
        const after = ev.clientX > rr.left + rr.width / 2;
        overTab.classList.add(after ? "drop-after" : "drop-before");
        let before = keyOf(overTab);
        if (after) {
          const nx = overTab.nextElementSibling && overTab.nextElementSibling.closest(tabSel);
          before = nx ? keyOf(nx) : null;
        }
        active.before = before;
        active.hasTarget = true;
      }
    };

    onUp = (ev) => {
      if (!active) { detachWindowListeners(); return; }
      const { key: k, before, started, hasTarget } = active;
      clear();
      // 위치 이동은 이 창 안에서 끝난 것만 처리한다. 창 밖으로 나간 경우는 main 이 이미 옮겼다.
      const r2 = strip.getBoundingClientRect();
      const inside = ev.clientX >= r2.left && ev.clientX < r2.right
        && ev.clientY >= r2.top && ev.clientY < r2.bottom;
      // 끈 뒤의 click 은 탭을 여는 동작이 아니므로 한 번만 무시한다.
      if (started) {
        window.addEventListener("click", (ce) => { ce.stopPropagation(); ce.preventDefault(); },
          { capture: true, once: true });
      }
      stopTabDrag();
      detachWindowListeners();
      if (started && inside && hasTarget && before !== k) move(k, before);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  });

  // Esc 는 취소다. 취소하려고 누른 키가 창을 만들면 안 된다.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !active) return;
    stopTabDrag();
    detachWindowListeners();
  }, true);
}

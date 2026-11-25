// 팝업 밖 누름·스크롤 전달. iframe·webview 안 누름과 스크롤을 이 문서의 바깥 누름(pointerdown·mousedown·click)으로 한 번 보냄
//
// 배경
//   팝업·메뉴는 이 문서의 누름으로 바깥 누름을 판정해 닫음(context-menu·usage·dropdown 등).
//   iframe(대화 화면·설정)과 webview(브라우저 탭) 안의 누름은 이 문서로 오지 않고, 스크롤은 어느 팝업도 보지 않아
//   팝업 밖을 누르거나 스크롤해도 열린 채 남았음
//
// 감지 방법
//   같은 출처 iframe: 그 문서 창의 pointerdown·wheel(캡처). 포커스가 이미 그 안에 있어도 잡힘
//   그 밖의 iframe·webview: 이 창의 blur 직후 activeElement 가 그 요소일 때. 포커스가 이미 안에 있으면 못 잡음
//   이 문서의 스크롤: 앱 본체(.app·.titlebar·.statusbar) 안일 때만. 팝업 층과 메뉴·목록·대화 상자 안 스크롤은 제외
//
// 유지 조건
//   대상은 documentElement. 팝업 안 판정(contains·closest)은 바깥이 되고 화면 요소의 클릭 처리기는 반응하지 않음
//   mouseup·pointerup 은 보내지 않음. 끌기 처리기(drag-shield 등)가 끝 신호로 받음
//   누름과 blur, 연이은 wheel 이 겹치므로 짧은 간격 안의 두 번째부터는 버림
//   iframe 을 다시 읽어도 contentWindow(WindowProxy)는 같은 객체라 연결 여부는 문서로 판정. load 마다 다시 연결

const SAME_PRESS_MS = 300;
const SHELL = ".app, .titlebar, .statusbar";
const POPUP_ROLES = new Set(["menu", "listbox", "dialog"]);

export function installFramePress({ win = window, doc = document, schedule = (fn) => setTimeout(fn, 0), now = () => Date.now() } = {}) {
  let lastAt = -Infinity;
  const watched = new WeakSet();

  function pressOutside() {
    const at = now();
    if (at - lastAt < SAME_PRESS_MS) return;
    lastAt = at;
    const target = doc.documentElement;
    const Pointer = win.PointerEvent || win.MouseEvent;
    const init = { bubbles: true, cancelable: true, button: 0 };
    target.dispatchEvent(new Pointer("pointerdown", init));
    target.dispatchEvent(new win.MouseEvent("mousedown", init));
    target.dispatchEvent(new win.MouseEvent("click", init));
  }

  function watch(frame) {
    try {
      const inner = frame?.contentWindow;
      const page = frame?.contentDocument;
      if (!inner || !page || watched.has(page)) return;
      inner.addEventListener("pointerdown", pressOutside, true);
      inner.addEventListener("wheel", pressOutside, { capture: true, passive: true });
      watched.add(page);
    } catch { /* 다른 출처: blur 로만 감지 */ }
  }

  // 앱 본체 안 스크롤만 바깥으로 봄. body 바로 아래가 앱 본체가 아니면 팝업 층
  function onWheel(e) {
    for (let el = e.target; el && el !== doc.body; el = el.parentElement) {
      if (POPUP_ROLES.has(el.getAttribute?.("role"))) return;
      if (el.parentElement === doc.body) { if (el.matches?.(SHELL)) pressOutside(); return; }
    }
  }

  win.addEventListener("blur", () => schedule(() => {
    const tag = doc.activeElement?.tagName;
    if (tag === "IFRAME" || tag === "WEBVIEW") pressOutside();
  }));
  doc.addEventListener("wheel", onWheel, { capture: true, passive: true });
  // load 는 버블링하지 않으므로 캡처로 받음
  doc.addEventListener("load", (e) => { if (e.target?.tagName === "IFRAME") watch(e.target); }, true);
  for (const frame of doc.querySelectorAll?.("iframe") || []) watch(frame);

  return { watch, onWheel };
}

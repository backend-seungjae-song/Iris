// 브라우저 패널 상호작용: 마우스→터치, viewport 손잡이, DevTools와 전역 pick 단축키를 맡는다.
//
// 소유 범위
//   현재 touch-drag 탭과 크기 drag 상태, 크기 메뉴·손잡이·DevTools·프레임 주입 명령,
//   ⌘⇧A/E/D capture listener 등록.
//
// 제공 API
//   initTouchDrag와 터치 동기화·크기 메뉴/drag·DevTools·Orca 주입 명령,
//   교체되는 size-drag 상태의 접근자.
//
// 의존 대상
//   browser/{pick,pick-host,record,webview,webview-store}, explorer/context-menu와 panel/viewport를 import한다.
//   main이 소유하는 $·blog·wsSend·showToast·acHost·BROWSER_MODE와 아직 main에 남은 dock 명령은 init에서 받는다.
//
// 유지 조건
//   touch 변환은 포인터가 모바일/패드 viewport 위에 있을 때만 켜고, 탭·창을 벗어나면 반드시 끈다.
//   drag 중 CDP 적용은 프레임당 한 번, 종료 적용은 한 번이며, ⌘⇧A/E/D capture 등록 순서를 유지한다.
//
// 영향 범위
//   main.js의 webview 생성·전환·폐기·shortcut/viewport 이벤트 배선과 browser/{pick-host,pick,record} init,
//   panel/viewport.js의 touch 해제 등록 계약, web/index.html의 #wv-stack/#wv-size/#wvh-* DOM·CSS,
//   native preload/cdp-control의 ac-viewport·framesInject·DevTools/shortcut 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/touch-drag.js

import { callHook } from "../core/hooks.js";
import { getWebview } from "../browser/webview-store.js";
import { activeBrowserId, activeWv } from "../browser/webview.js";
import { askText, showCtx } from "../explorer/context-menu.js";
import {
  applyViewport, deviceClassOf, registerViewportTouchDrag, updateSizeBtn,
  VIEWPORT_PRESETS, viewportByTab, viewportLayout,
} from "./viewport.js";

let $, blog, wsSend, showToast, acHost, BROWSER_MODE, toggleDock;
let touchDragTab = null;
let sizeDrag = null;

export function initTouchDrag(deps) {
  ({ $, blog, wsSend, showToast, acHost, BROWSER_MODE, toggleDock } = deps);
  registerViewportTouchDrag({ setTouchDrag });

  // 탭별 webview 생성과 이벤트 연결.
  // ⌘⇧E 요소선택 · ⌘⇧D 스케치 · ⌘⇧O 분리: capture 단계에서 가장 먼저 처리한다. 터미널(xterm)·입력창·webview 등
  // 어디에 포커스가 있어도 중간에서 삼켜지지 않게 하기 위함이다(터미널 포커스 시 안 먹던 문제).
  // 게이팅은 활성 webview 존재로만 한다. 메인 창·분리 브라우저 창 양쪽에서 동일하게 동작한다.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    const k = (e.key || "").toLowerCase();
    // 문서 탭(docx/sheet)이 활성이면 webview가 없다. BROWSER_MODE라고 무조건 로컬 토글하면
    // "녹화 중" 표시만 켜지고 아무것도 기록되지 않는다.
    // 게이팅은 위 주석대로 활성 webview 존재로만 한다.
    if (k === "a") { e.preventDefault(); e.stopPropagation(); if (activeWv()) callHook("record.set", !callHook("record.on")); else if (!BROWSER_MODE) wsSend({ type: "rec-toggle-relay" }); return; }
    // ⌘⇧D 스케치: 지금 포커스가 있는 창의 활성 탭을 찍는다. 이 창에 webview 가 없으면(브라우저를
    // 분리해 뒀을 때) 분리 창에서 열도록 넘긴다. 녹화 토글과 같은 되돌림 경로다.
    if (k === "d") {
      e.preventDefault(); e.stopPropagation();
      if (activeWv()) callHook("sketch.open"); else if (!BROWSER_MODE) wsSend({ type: "sketch-open-relay" });
      return;
    }
    if (k !== "e" && k !== "o") return;
    // 브라우저가 분리돼 나가면 메인 창엔 webview가 없다. 그때 ⌘⇧E는 분리 창의 선택 모드를 켠다.
    // 사용자는 메인 창 터미널에서 명령을 치다가 그대로 요소를 고르기 때문이다(요소는 pick-relay로 되돌아온다).
    if (k === "o") { e.preventDefault(); e.stopPropagation(); toggleDock(); return; } // 분리/도킹은 webview 유무와 무관
    // 어느 창에서 눌러도 결과는 하나다. 서버가 값을 뒤집고 모든 창에 같은 값을 돌려준다. webview 유무로
    // 갈라 relay 하면 두 창의 상태가 반대가 된다.
    e.preventDefault(); e.stopPropagation();
    callHook("pick.toggle");
  }, true);
}

// 이것만은 탭에 갇히지 않는다. <webview>는 OS 마우스가 감싸는 창의 위젯을 거쳐 들어와서, 켜 두면
// 앱 헤더와 다른 탭 커서까지 터치가 된다. 그래서 포인터가 그 화면 안에 있는
// 동안만 켜고, 나가거나 탭을 옮기거나 창이 포커스를 잃으면 반드시 끈다.
async function setTouchDrag(tabId, on) {
  if (on && touchDragTab === tabId) return;
  if (!on && touchDragTab !== tabId) return;
  const rec = tabId ? getWebview(tabId) : null;
  if (!rec || !rec.el) { touchDragTab = null; return; }
  let wcId = 0;
  try { wcId = rec.el.getWebContentsId(); } catch {}
  if (!wcId) return;
  touchDragTab = on ? tabId : null;
  try { await acHost?.setViewport({ wcId, touchDrag: !!on }); } catch {}
}

// 현재 상태에 맞게 정리한다. 켤 조건이 아니면(지정 없음·데스크톱 크기·다른 탭) 끈다.
export function syncTouchDrag(hovering) {
  const id = activeBrowserId();
  const vp = id ? viewportByTab[id] : null;
  const want = !!(hovering && vp && deviceClassOf(vp.w) !== "데스크톱");
  if (touchDragTab && touchDragTab !== id) setTouchDrag(touchDragTab, false);
  if (want) setTouchDrag(id, true);
  else if (touchDragTab) setTouchDrag(touchDragTab, false);
}

// 손잡이로 직접 드래그한다. webview는 별도 프로세스라 마우스가 그쪽으로 넘어가므로 드래그 중에는 덮개를 씌운다.
export function startSizeDrag(e, axis) {
  const id = activeBrowserId(); const vp = id ? viewportByTab[id] : null;
  if (!vp || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const wrap = $("#wv-stack");
  const mask = document.createElement("div");
  mask.className = "wv-dragmask";
  mask.style.cursor = axis === "r" ? "ew-resize" : axis === "b" ? "ns-resize" : "nwse-resize";
  wrap.appendChild(mask);
  sizeDrag = { id, axis, x: e.clientX, y: e.clientY, mask, pending: 0 };
  document.addEventListener("mousemove", onSizeDrag, true);
  document.addEventListener("mouseup", endSizeDrag, true);
}

function onSizeDrag(e) {
  const d = sizeDrag; if (!d) return;
  const vp = viewportByTab[d.id]; if (!vp) return endSizeDrag();
  if (d.axis !== "b") vp.w = Math.max(180, vp.w + (e.clientX - d.x));
  if (d.axis !== "r") vp.h = Math.max(180, vp.h + (e.clientY - d.y));
  d.x = e.clientX; d.y = e.clientY;
  viewportLayout(); updateSizeBtn();
  // 페이지 쪽 적용은 프레임마다 한 번만 한다. 매 픽셀 CDP를 부르면 드래그가 끊긴다.
  if (!d.pending) d.pending = requestAnimationFrame(() => {
    d.pending = 0; if (sizeDrag) applyViewport(d.id, viewportByTab[d.id], true);
  });
}

function endSizeDrag() {
  const d = sizeDrag; if (!d) return;
  sizeDrag = null;
  if (d.pending) cancelAnimationFrame(d.pending);
  try { d.mask.remove(); } catch {}
  document.removeEventListener("mousemove", onSizeDrag, true);
  document.removeEventListener("mouseup", endSizeDrag, true);
  applyViewport(d.id, viewportByTab[d.id]);   // 손을 놓을 때 한 번: 기기가 바뀌었으면 여기서 새로고침
}

export function isSizeDragging() { return !!sizeDrag; }

export function openSizeMenu() {
  const id = activeBrowserId();
  if (!id) { showToast("브라우저 탭에서만 크기를 지정할 수 있습니다."); return; }
  const cur = viewportByTab[id];
  const items = VIEWPORT_PRESETS.map((p) => ({
    label: (cur && cur.w === p.w && cur.h === p.h ? "● " : "　") + p.label,
    act: () => applyViewport(id, { w: p.w, h: p.h }),
  }));
  items.push({ sep: true });
  items.push({ label: "직접 입력…", act: async () => {
    const v = await askText("화면 크기", cur ? `${cur.w}x${cur.h}` : "390x844", "가로x세로 (예: 768x1024)");
    if (v == null) return;
    const m = String(v).match(/(\d+)\s*[x×*,\s]\s*(\d+)/);
    if (!m) { showToast("가로x세로 형식으로 입력하세요."); return; }
    applyViewport(id, { w: +m[1], h: +m[2] });
  } });
  items.push({ label: "해제(원래 크기)", disabled: !cur, act: () => { if (cur) applyViewport(id, null); } });
  const r = $("#wv-size").getBoundingClientRect();
  showCtx(r.left, r.bottom + 4, items);
}

// F12 = 지금 보고 있는 브라우저 탭의 개발자 도구. <webview>는 요소 쪽 API로 열어야 한다.
// 메인 프로세스에서 게스트 webContents.openDevTools()를 부르면 열리지 않는다(측정).
// 위장 주입용으로 붙여둔 디버거와는 공존한다(같이 붙어 있어도 양쪽 명령이 정상, 측정).
export async function toggleDevTools() {
  const r = activeWv();
  if (!r || !r.el) { showToast("개발자 도구는 브라우저 탭에서 열립니다."); return; }
  try {
    if (r.el.isDevToolsOpened()) r.el.closeDevTools();
    else {
      await callHook("extensionloader.before-devtools", { partition: r.el.partition });
      r.el.openDevTools();
    }
  } catch (e) { showToast("개발자 도구를 열지 못했습니다: " + (e.message || e)); }
}

// 요소 선택 모드 = 항상 화면 고정과 함께(별도 토글 없음). on/off 모두 __orcaSet 한 함수로 결정.
export function setOrca(el, on) {
  if (!el) return;
  // 주입할 코드는 그 기능이 만든다. 꺼져 있으면 받을 것이 없고, 그때는 아무것도 주입하지 않는다.
  const src = callHook("pick.orcaSource", on);
  if (!src) return;
  try { el.executeJavaScript(src).catch((e) => blog("orca err", String(e && e.message || e))); }
  catch (e) { blog("orca throw", e.message); }
  injectAllFrames(el, "orca", src, on);
}

// executeJavaScript 는 최상위 프레임에서만 돈다. 화면의 알맹이가 iframe 안에 있는 사이트
// (어드민 본문, 감싸는 페이지 안의 iframe 문서)에서는 눌러도 동작하지 않고, 그 안의 조작은 녹화에도
// 남지 않는다. 그래서 메인 프로세스가 CDP로 프레임마다 같은 코드를 주입한다.
export function injectAllFrames(el, key, src, on) {
  try {
    const wc = el && el.getWebContentsId ? el.getWebContentsId() : null;
    if (wc && window.acHost && acHost.framesInject) acHost.framesInject(wc, key, src, on);
  } catch (e) { blog("frames inject", key, String(e && e.message || e)); }
}

export function injectPick(el) { setOrca(el, true); } // dom-ready·탭전환 시 pickMode면 재적용 경로

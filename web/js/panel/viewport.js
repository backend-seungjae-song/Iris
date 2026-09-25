// 브라우저 탭 화면 크기: 탭별 CDP viewport와 그 화면의 패널 배치를 맡는다.
//
// 소유 범위
//   viewport preset·기기 성격 경계, 탭별 지정 크기와 크기 버튼·webview 배치 갱신.
//
// 제공 API
//   initViewport와 touch-drag 등록 경계, 크기 적용·배치·버튼 갱신 명령,
//   교체되지 않는 탭별 viewport 그릇과 기기 성격 판정.
//
// 의존 대상
//   활성 브라우저 탭과 webview 항목은 browser/{webview,webview-store}에서 import한다.
//   main이 소유하는 $·showToast·acHost는 init에서 받고, touch-drag 해제는 등록 콜백으로 받는다.
//
// 유지 조건
//   화면은 CDP 응답보다 먼저 바꾸고, live drag 중에는 reload하지 않으며, 해제할 때 터치 변환도 내린다.
//   지정 크기는 탭별로 유지하고 CSS 배율 없이 실제 w×h로 가운데 배치한다.
//
// 영향 범위
//   main.js의 webview 생성·전환·폐기·외부 viewport 변경 배선과 panel/touch-drag.js의 크기 조절·터치 해제,
//   web/index.html의 #wv-size/#wv-stack/#wv-sizebadge/#wvh-* DOM·CSS, native preload/cdp-control의 ac-viewport 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/viewport.js

import { getWebview } from "../browser/webview-store.js";
import { activeBrowserId } from "../browser/webview.js";

let $, showToast, acHost;
let setTouchDrag = () => {};

export const VIEWPORT_PRESETS = [
  { label: "폰 (390×844)", w: 390, h: 844 },
  { label: "큰 폰 (430×932)", w: 430, h: 932 },
  { label: "패드 (820×1180)", w: 820, h: 1180 },
  { label: "노트북 (1280×800)", w: 1280, h: 800 },
  { label: "데스크톱 (1920×1080)", w: 1920, h: 1080 },
];
export const deviceClassOf = (w) => (w <= 480 ? "모바일" : w <= 840 ? "패드" : "데스크톱");
// 탭별 지정 크기. webview를 새로 만들면(프로필 변경·재도킹) 지정은 게스트와 함께 사라지므로
// 여기서도 지운다. 버튼이 실제와 다른 크기를 표시하지 않게 한다.
export const viewportByTab = {};

export function initViewport(deps) {
  ({ $, showToast, acHost } = deps);
}

export function registerViewportTouchDrag(handlers) {
  ({ setTouchDrag } = handlers);
}

const SIZE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>';
export function updateSizeBtn() {
  const btn = $("#wv-size"); if (!btn) return;
  const id = activeBrowserId();
  const vp = id ? viewportByTab[id] : null;
  // 크기를 지정하지 않았으면 아이콘만, 지정했으면 그 값을 붙인다. 지금 보는 화면이 실제 크기가 아니라는 표시다.
  btn.innerHTML = SIZE_ICON + (vp ? `<span>${vp.w}×${vp.h}</span>` : "");
  btn.classList.toggle("on", !!vp);
}

export async function applyViewport(tabId, vp, quiet) {
  const rec = tabId ? getWebview(tabId) : null;
  if (!rec || !rec.el) { showToast("브라우저 탭에서만 크기를 지정할 수 있습니다."); return; }
  let wcId = 0;
  try { wcId = rec.el.getWebContentsId(); } catch {}
  if (!wcId) { showToast("탭이 아직 준비되지 않았습니다."); return; }
  if (vp) viewportByTab[tabId] = vp; else delete viewportByTab[tabId];
  if (!vp) setTouchDrag(tabId, false);    // 해제하면 터치 변환도 같이 내린다
  updateSizeBtn(); viewportLayout();      // 화면은 먼저 바꾼다. 드래그 중에 포인터를 따라와야 한다
  // live = 손잡이를 드래그하는 중. 이때는 기기가 바뀌어도 새로고침하지 않는다(놓았을 때 한 번만).
  const r = await acHost?.setViewport(vp ? { wcId, width: vp.w, height: vp.h, live: !!quiet } : { wcId, clear: true });
  if (!r || !r.ok) { showToast("크기를 바꾸지 못했습니다: " + ((r && r.error) || "알 수 없음")); return; }
  if (!quiet) showToast(vp ? `화면 크기 ${vp.w}×${vp.h} · ${deviceClassOf(vp.w)}` : "화면 크기 해제");
}

// 지정한 크기 그대로 화면을 만들어 가운데 둔다. 배율은 걸지 않는다. 배율을 걸면 크기 조절이
// 아니라 확대·축소가 되어 반응형 확인에 쓸 수 없다.
export function viewportLayout() {
  const wrap = $("#wv-stack"); if (!wrap) return;
  const id = activeBrowserId();
  const vp = id ? viewportByTab[id] : null;
  wrap.classList.toggle("sized", !!vp);
  const badge = $("#wv-sizebadge"), hr = $("#wvh-r"), hb = $("#wvh-b"), hc = $("#wvh-c");
  for (const el of [badge, hr, hb, hc]) if (el) el.hidden = !vp;
  if (!vp) { for (const k of ["--vw", "--vh", "--vleft", "--vtop"]) wrap.style.removeProperty(k); return; }
  const pad = 12;
  const left = Math.max(pad, Math.round((wrap.clientWidth - vp.w) / 2));
  const top = Math.max(pad, Math.round((wrap.clientHeight - vp.h) / 2));
  wrap.style.setProperty("--vw", vp.w + "px");
  wrap.style.setProperty("--vh", vp.h + "px");
  wrap.style.setProperty("--vleft", left + "px");
  wrap.style.setProperty("--vtop", top + "px");
  if (hr) { hr.style.left = (left + vp.w) + "px"; hr.style.top = top + "px"; hr.style.height = vp.h + "px"; }
  if (hb) { hb.style.left = left + "px"; hb.style.top = (top + vp.h) + "px"; hb.style.width = vp.w + "px"; }
  if (hc) { hc.style.left = (left + vp.w) + "px"; hc.style.top = (top + vp.h) + "px"; }
  if (badge) { badge.style.left = left + "px"; badge.style.top = Math.max(2, top - 20) + "px";
    badge.textContent = `${vp.w} × ${vp.h} · ${deviceClassOf(vp.w)}`; }
}

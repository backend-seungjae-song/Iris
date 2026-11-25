// 대화 화면 안에 열린 메뉴·목록 선택 상자를 팝업 밖 누름·스크롤로 닫음
// - Paseo 메뉴·목록 상자는 화면 전체를 덮는 투명 배경을 깔고 그 배경 누름으로 닫힘. iframe 안에서는 배경이
//   iframe 안에만 있어 본 화면을 누르거나 스크롤해도 닫히지 않았고, 배경 위 스크롤도 닫지 않았음
// - 본 화면 누름: 이 창의 blur, 그리고 같은 출처인 부모 문서의 pointerdown. 본 화면 스크롤: 부모 문서의 wheel
// - 부모 문서의 가짜 누름(isTrusted false)은 제외. 이 화면 안 누름을 본 화면에 전달한 것(core/frame-press.js)이라
//   메뉴 항목을 누르는 순간 메뉴가 먼저 닫힘
// - 이 화면 안 스크롤은 배경 위일 때만. 메뉴 목록 스크롤은 그대로 둠
// - 대화 상자(칩 편집 등)는 배경이 없어 닫히지 않음. 고친 글이 버려지지 않게 대상에서 뺌

const COMBOBOX_SURFACE = '[data-testid="combobox-desktop-container"]';

// 메뉴 배경(이름표가 menu.backdrop 번역값)과 목록 상자 표면 바로 앞 형제
export function floatingBackdrops(doc, menuLabel) {
  const out = [];
  if (menuLabel) for (const el of doc.querySelectorAll(`[aria-label="${CSS.escape(menuLabel)}"]`)) out.push(el);
  for (const surface of doc.querySelectorAll(COMBOBOX_SURFACE)) {
    if (surface.previousElementSibling) out.push(surface.previousElementSibling);
  }
  return out;
}

export function installBlurDismiss({ menuLabel }) {
  const closeAll = () => { for (const backdrop of floatingBackdrops(document, menuLabel())) backdrop.click(); };
  window.addEventListener("blur", closeAll);
  window.addEventListener("wheel", (e) => {
    if (floatingBackdrops(document, menuLabel()).includes(e.target)) closeAll();
  }, { capture: true, passive: true });
  let host = null;
  try { host = window.parent !== window ? window.parent.document : null; } catch { /* 다른 출처 부모 */ }
  if (!host) return;
  // 이 화면을 다시 읽으면 부모 문서에 남은 리스너가 닫힌 문서를 붙들므로 내릴 때 뗌
  const off = new AbortController();
  host.addEventListener("pointerdown", (e) => { if (e.isTrusted) closeAll(); }, { capture: true, signal: off.signal });
  host.addEventListener("wheel", (e) => { if (e.isTrusted) closeAll(); }, { capture: true, passive: true, signal: off.signal });
  window.addEventListener("pagehide", () => off.abort(), { once: true });
}

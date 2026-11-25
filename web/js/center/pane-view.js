import { callHook } from "../core/hooks.js";
import { getCenterSpace } from "./tab-store.js";
import { paneFocus, paneIndex, paneLayout } from "./pane-store.js";

let center, paneBody, browser, stack, slot, rows = [], changed, hiddenObserver;
let scheduled = false, keepWindowSize = "";
const files = [], notices = [];
export function filePane(index = 0) { return files[index] || document.getElementById("fileview"); }
export function paneNotices() { return notices; }
export function initPaneView({ tabstrip, browserview, onFocus, onTransfer }) {
  center = document.getElementById("center");
  paneBody = document.getElementById("center-body"); browser = browserview; changed = onFocus;
  for (const index of [0, 1]) {
    const file = document.createElement("div");
    file.className = "fileview"; file.dataset.pane = String(index); file.hidden = true;
    paneBody.appendChild(file); files.push(file);
    const notice = document.createElement("button");
    notice.type = "button"; notice.className = "center-pane-notice";
    notice.dataset.pane = String(index); notice.hidden = true;
    notice.textContent = "다른 칸에서 표시 중. 누르면 여기서 표시";
    notice.addEventListener("click", () => { paneFocus(getCenterSpace(), index); onTransfer(); });
    paneBody.appendChild(notice); notices.push(notice);
  }
  const first = tabstrip.parentElement;
  first.dataset.pane = "0";
  const second = document.createElement("div");
  second.className = "tabbar-row center-pane-row"; second.dataset.pane = "1"; second.hidden = true;
  const kinds = document.createElement("div"); kinds.className = "tab-kinds";
  kinds.setAttribute("role", "group"); kinds.setAttribute("aria-label", "보기 종류");
  const strip = document.createElement("div"); strip.className = "tabstrip";
  second.append(kinds, strip); first.after(second);
  rows = [{ row: first, strip: tabstrip }, { row: second, strip, kinds }];
  rows.forEach((row, index) => { row.strip.dataset.pane = String(index); row.strip.tabIndex = -1; });
  stack = document.getElementById("wv-stack");
  if (stack.querySelector("webview")) throw new Error("webview 생성 전 공용 층 초기화 필요");
  slot = document.createElement("div"); slot.className = "center-browser-slot";
  stack.before(slot); paneBody.appendChild(stack); stack.classList.add("center-webviews");
  const focus = (index) => {
    const layout = paneLayout(getCenterSpace());
    if (!layout || layout.focus === index || index < 0) return;
    paneFocus(getCenterSpace(), index); changed(); syncPaneView();
  };
  center.addEventListener("pointerdown", (event) => {
    const owner = event.target.closest("[data-pane]");
    if (owner) focus(Number(owner.dataset.pane));
  }, true);
  center.addEventListener("focusin", (event) => {
    if (isBehindGuest(event.target)) return;
    const owner = event.target.closest("[data-pane]");
    if (owner) focus(Number(owner.dataset.pane));
  });
  const wired = new WeakSet();
  const wireGuests = () => {
    for (const el of stack.querySelectorAll("webview")) {
      if (wired.has(el)) continue;
      wired.add(el);
      const select = () => { if (!isBehindGuest(el)) focus(paneIndex(getCenterSpace(), el.dataset.tab)); };
      el.addEventListener("focus", select);
      el.addEventListener("ipc-message", (event) => { if (event.channel === "ac-guest-pointerdown") select(); });
    }
  };
  new MutationObserver(wireGuests).observe(stack, { childList: true });
  new ResizeObserver(schedulePaneLayout).observe(slot);
  new ResizeObserver(schedulePaneLayout).observe(paneBody);
  hiddenObserver = new MutationObserver(schedulePaneLayout);
  hiddenObserver.observe(browser, { attributes: true, attributeFilter: ["hidden", "class"] });
  window.addEventListener("resize", schedulePaneLayout);
  return rows;
}
// 뒤에 깔린 AI 탭은 사용자가 누를 수 없어(pointer-events:none) 그 탭의 포커스·포인터 신호는 AI 조작이 만든 것
function isBehindGuest(el) { return !!el?.classList?.contains("ai-behind"); }
export function paneRows() { return rows; }
export function syncPaneView() {
  if (!center) return;
  const layout = paneLayout(getCenterSpace());
  center.toggleAttribute("data-split", !!layout);
  center.dataset.focus = String(layout?.focus || 0);
  center.style.setProperty("--center-split", `${(layout?.ratio || 0.5) * 100}%`);
  rows[1].row.hidden = !layout;
  callHook("split.bodyReady", paneBody);
  schedulePaneLayout();
}
// 숨은 브라우저 칸을 같은 프레임 안에서 잠깐 펼쳐 실제 배치 크기를 잰다(그리기 전에 되돌려 화면은 안 바뀐다)
// - 뒤에 깐 AI 탭이 없으면 재지 않는다
// - 칸은 그 AI 탭이 속한 칸(paneIndex)으로 잰다. 사용자가 그 탭을 열면 브라우저가 그 칸으로 옮겨 가기 때문
// - 중앙 영역이 접힌(util-full)·모바일 가림 상태는 펼쳐도 실제 칸 크기가 아니라서(body class 를 임시로 바꾸면
//   다른 관찰자가 반응함) 재지 않고 null
function measureHiddenSlot() {
  const pending = stack.hasAttribute("data-ai-keep-pending");
  if ((!stack.classList.contains("ai-keep") && !pending) || !browser.hidden) return null;
  const folded = document.body.classList.contains("util-full")
    || (window.innerWidth <= 820 && !center.classList.contains("mobile-show"));
  if (folded) return null;
  const behind = stack.querySelector("webview.ai-behind, webview[data-ai-behind-pending]");
  const pane = behind ? Math.max(0, paneIndex(getCenterSpace(), behind.dataset.tab)) : (paneLayout(getCenterSpace())?.focus || 0);
  const prevPane = browser.dataset.pane;
  browser.dataset.pane = String(pane);
  browser.style.visibility = "hidden";
  browser.hidden = false;
  const rect = slot.getBoundingClientRect();
  browser.hidden = true;
  browser.style.visibility = "";
  if (prevPane === undefined) delete browser.dataset.pane; else browser.dataset.pane = prevPane;
  hiddenObserver.takeRecords();   // 위 되돌림이 레이아웃을 다시 부르지 않게 비움
  return rect.width > 0 && rect.height > 0 ? rect : null;
}
export function schedulePaneLayout() {
  if (scheduled || !paneBody) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const bounds = paneBody.getBoundingClientRect(), rect = slot.getBoundingClientRect();
    const visible = !browser.hidden && rect.width > 0 && rect.height > 0;
    stack.hidden = !visible;
    for (const [key, value] of Object.entries({ left: rect.left - bounds.left, top: rect.top - bounds.top,
      width: rect.width, height: rect.height })) paneBody.style.setProperty(`--center-browser-${key}`, `${value}px`);
    // 뒤에 깐 AI 탭이 따라갈 칸 위치·크기(창 기준). 칸이 숨은 동안에는 펼쳤을 때의 크기를 재서 쓴다
    // 접힌 상태에서는 같은 창 크기에서 잰 값만 믿고, 아니면 지움(CSS 기본값 0 이라 webview.js 가 0 크기로 보고 깔기를 포기)
    const keep = visible ? rect : measureHiddenSlot();
    const windowSize = `${window.innerWidth}x${window.innerHeight}`;
    if (keep) {
      for (const [key, value] of Object.entries({ left: keep.left, top: keep.top,
        width: keep.width, height: keep.height })) paneBody.style.setProperty(`--keep-${key}`, `${value}px`);
      keepWindowSize = windowSize;
    } else if (keepWindowSize !== windowSize) {
      for (const key of ["left", "top", "width", "height"]) paneBody.style.removeProperty(`--keep-${key}`);
      keepWindowSize = "";
    }
    stack.dataset.pane = browser.dataset.pane || "0";
  });
}

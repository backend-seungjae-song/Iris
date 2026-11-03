import { callHook } from "../core/hooks.js";
import { getCenterSpace } from "./tab-store.js";
import { paneFocus, paneIndex, paneLayout } from "./pane-store.js";

let center, paneBody, browser, stack, slot, rows = [], changed;
let scheduled = false;
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
    notice.textContent = "다른 칸에서 보는 중 — 눌러서 여기서 보기";
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
    const owner = event.target.closest("[data-pane]");
    if (owner) focus(Number(owner.dataset.pane));
  });
  const wired = new WeakSet();
  const wireGuests = () => {
    for (const el of stack.querySelectorAll("webview")) {
      if (wired.has(el)) continue;
      wired.add(el);
      const select = () => focus(paneIndex(getCenterSpace(), el.dataset.tab));
      el.addEventListener("focus", select);
      el.addEventListener("ipc-message", (event) => { if (event.channel === "ac-guest-pointerdown") select(); });
    }
  };
  new MutationObserver(wireGuests).observe(stack, { childList: true });
  new ResizeObserver(schedulePaneLayout).observe(slot);
  new ResizeObserver(schedulePaneLayout).observe(paneBody);
  new MutationObserver(schedulePaneLayout).observe(browser, { attributes: true, attributeFilter: ["hidden", "class"] });
  window.addEventListener("resize", schedulePaneLayout);
  return rows;
}
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
    stack.dataset.pane = browser.dataset.pane || "0";
  });
}

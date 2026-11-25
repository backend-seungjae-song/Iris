// 입력 기록 제안
// 소유 범위: webview 위의 호스트 목록과 사용자 선택
// 제공 API: initCapability와 formhistory.guest 훅
// 의존 대상: acHost 입력 기록 IPC, AI 조작 상태, webview 프레임 메시지
// 유지 조건: 게스트에는 열림 상태와 선택한 값 하나만 전달
// 영향 범위: 본 창과 분리 브라우저 창의 webview
import { provide } from "../core/hooks.js";
import { aiHolds } from "./ai-state.js";

const sameFrame = (a, b) => a[0] === b[0] && a[1] === b[1];
const validFrame = (id) => Array.isArray(id) && id.length === 2 && id.every(Number.isInteger);

function position(box, { el, rect }) {
  const bounds = el.getBoundingClientRect();
  const zoom = el.getZoomFactor();
  const left = Math.max(0, bounds.left, bounds.left + rect.left * zoom);
  const top = bounds.top + (rect.top + rect.height) * zoom;
  const space = Math.min(innerWidth, bounds.right) - left;
  if (space <= 0 || top < Math.max(0, bounds.top) || top >= innerHeight) return false;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${Math.min(space, Math.max(140, rect.width * zoom))}px`;
  box.style.maxHeight = `${Math.min(innerHeight - top, 260)}px`;
  return true;
}

export function initCapability() {
  const box = document.createElement("div");
  box.className = "form-history-list";
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "입력 기록");
  box.hidden = true;
  document.body.append(box);
  let current;
  let watchId;

  function send({ el, frameId, fieldId }, channel, data) {
    try { void el.sendToFrame(frameId, channel, { fieldId, ...data }).catch(() => {}); }
    catch {} // 이미 떨어진 webview 또는 프레임
  }

  function close() {
    if (!current) return;
    const previous = current;
    current = null;
    cancelAnimationFrame(watchId);
    previous.listeners.abort();
    box.hidden = true;
    box.replaceChildren();
    if (previous.open) send(previous, "ac-fh-state", { open: false, selected: false });
  }

  function available({ tabId, el }) {
    return !aiHolds(tabId) && el.isConnected && el.classList.contains("active") && el.checkVisibility();
  }

  function watch() {
    if (!current || !available(current)) close();
    else watchId = requestAnimationFrame(watch);
  }

  function paint(menu) {
    box.replaceChildren(...menu.values.map((value, index) => {
      const row = document.createElement("div");
      row.className = "form-history-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === menu.selected));
      row.textContent = value;
      row.addEventListener("click", (event) => {
        if (event.isTrusted) choose(menu, index);
      });
      return row;
    }));
    box.hidden = false;
    box.children[menu.selected]?.scrollIntoView({ block: "nearest" });
    send(menu, "ac-fh-state", { open: true, selected: menu.selected >= 0 });
  }

  function choose(menu, index) {
    if (current !== menu) return;
    if (!available(menu)) { close(); return; }
    const value = menu.values[index];
    if (value === undefined) return;
    send(menu, "ac-fh-fill", { value });
    close();
  }

  async function useKey(menu, key) {
    const { values, selected } = menu;
    if (key === "Escape") { close(); return; }
    if (key === "Enter") {
      if (selected >= 0) choose(menu, selected);
      return;
    }
    if (key === "Shift+Delete") {
      if (selected < 0) return;
      const value = values[selected];
      const removed = await window.acHost?.formHistoryRemove(menu.partition, menu.key, value);
      if (current !== menu || !removed || !available(menu)) return;
      const index = values.indexOf(value);
      if (index < 0) return;
      const selectedValue = values[menu.selected];
      values.splice(index, 1);
      if (!values.length) { close(); return; }
      menu.selected = values.indexOf(selectedValue);
    } else {
      const direction = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
      if (!direction) return;
      menu.selected = selected < 0 ? (direction === 1 ? 0 : values.length - 1)
        : (selected + direction + values.length) % values.length;
    }
    paint(menu);
  }

  async function requestMenu(payload, context) {
    if (!available(context)) return;
    const { fieldId, key, prefix, rect } = payload;
    if (typeof key !== "string" || !key || typeof prefix !== "string"
      || !rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return;
    close();
    const listeners = new AbortController();
    const menu = { ...context, fieldId, key, rect, listeners, selected: -1 };
    current = menu;
    const { signal } = listeners;
    menu.el.addEventListener("did-start-navigation", (event) => {
      if (event.isMainFrame || sameFrame(menu.frameId, [event.frameProcessId, event.frameRoutingId])) close();
    }, { signal });
    menu.el.addEventListener("render-process-gone", close, { signal });
    watch();

    try {
      const values = await window.acHost?.formHistoryQuery(menu.partition, key, prefix, menu.el.getWebContentsId());
      if (current !== menu) return;
      if (!available(menu) || !Array.isArray(values) || !values.length || !position(box, menu)) { close(); return; }
      menu.values = values;
      menu.open = true;
      paint(menu);
    } catch {
      if (current === menu) close();
    }
  }

  async function guest(channel, payload, context) {
    if (context.blocked || aiHolds(context.tabId)) {
      if (current?.el === context.el) close();
      return;
    }
    try {
      if (channel === "ac-fh-submit") {
        if (Array.isArray(payload?.entries)) {
          await window.acHost?.formHistoryAdd(context.partition, payload.entries, context.el.getWebContentsId());
        }
        return;
      }
      if (!validFrame(context.frameId) || typeof payload?.fieldId !== "string") return;
      if (channel === "ac-fh-field") { await requestMenu(payload, context); return; }
      if (current?.el !== context.el || !sameFrame(current.frameId, context.frameId)
        || current.fieldId !== payload.fieldId) return;
      if (channel === "ac-fh-hide" || !available(current)) close();
      else if (channel === "ac-fh-key" && current.open) await useKey(current, payload.key);
    } catch {} // 앱 종료나 기능 상태 변경 중 끊긴 IPC
  }

  box.addEventListener("mousedown", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => { if (!box.contains(event.target)) close(); }, true);
  document.addEventListener("scroll", (event) => { if (!box.contains(event.target)) close(); }, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  provide("formhistory.guest", guest);
  return {};
}

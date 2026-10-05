// 소유 범위: 주소창 번역 버튼과 언어·번역 설정 팝업.
// 제공 API: createTranslateControls → update, open, close, dispose.
// 의존 대상: 현재 주소창과 core/dropdown; 번역 실행·설정 저장은 호출자가 맡는다.
// 유지 조건: 자동으로 열린 팝업은 입력 포커스를 바꾸지 않는다.
import { createDropdown } from "../core/dropdown.js";

export function createTranslateControls({ onTranslate, onRestore, onPreference, onTargetChange, onSourceChange } = {}) {
  const tools = document.querySelector(".urlbar .ub-tools");
  if (!tools) return { update() {}, open() {}, close() {}, dispose() {} };
  const events = new AbortController();
  const listen = (el, type, fn, options = {}) => el.addEventListener(type, fn, { ...options, signal: events.signal });
  const button = document.createElement("button");
  button.id = "wv-translate";
  button.type = "button";
  button.className = "ico page-translate-button";
  button.title = "이 페이지 번역";
  button.setAttribute("aria-label", "이 페이지 번역");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "page-translate-panel");
  const glyph = document.createElement("span");
  glyph.className = "page-translate-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "A文";
  button.append(glyph);
  button.hidden = true;
  tools.prepend(button);

  const panel = document.createElement("div");
  panel.id = "page-translate-panel";
  panel.className = "page-translate-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "페이지 번역");
  panel.hidden = true;
  // Electron의 webview 위에도 표시되어야 하므로 지원되는 환경에서는 top layer를 쓴다.
  const nativePopover = typeof panel.showPopover === "function";
  if (nativePopover) panel.setAttribute("popover", "manual");
  panel.innerHTML = `<div class="page-translate-header">
    <div class="page-translate-tabs" role="group" aria-label="페이지 표시 언어">
      <button type="button" class="page-translate-tab" data-translate-action="original"></button>
      <button type="button" class="page-translate-tab" data-translate-action="translated"></button>
    </div>
    <button type="button" class="ico" data-translate-action="options" aria-label="번역 옵션" aria-expanded="false" aria-controls="page-translate-options">⋯</button>
    <button type="button" class="ico" data-translate-action="close" aria-label="번역 팝업 닫기">×</button>
  </div>
  <div class="page-translate-status" role="status" aria-live="polite"></div>
  <button type="button" class="cc-btn page-translate-retry" data-translate-action="retry" hidden>다시 시도</button>
  <label class="page-translate-preference"><input type="checkbox" data-translate-preference="alwaysLanguage"><span></span></label>
  <div class="page-translate-options" id="page-translate-options" hidden>
    <div class="page-translate-language" data-translate-language="source"><span>페이지 언어</span></div>
    <div class="page-translate-language" data-translate-language="target"><span>번역 언어</span></div>
    <label class="page-translate-preference"><input type="checkbox" data-translate-preference="neverLanguage"><span></span></label>
    <label class="page-translate-preference"><input type="checkbox" data-translate-preference="neverSite"><span>이 사이트 번역 안 함</span></label>
  </div>`;
  document.body.append(panel);
  const original = panel.querySelector('[data-translate-action="original"]');
  const translated = panel.querySelector('[data-translate-action="translated"]');
  const optionsButton = panel.querySelector('[data-translate-action="options"]');
  const options = panel.querySelector(".page-translate-options");
  const status = panel.querySelector(".page-translate-status");
  const retry = panel.querySelector(".page-translate-retry");
  let state = { visible: false, sourceLanguage: "auto", targetLanguage: "ko", status: "idle", languages: [] };
  let dropdowns = [];
  let languageItems = "";
  let disposed = false;
  let displayNames;
  try { displayNames = new Intl.DisplayNames(["ko"], { type: "language" }); } catch {}

  function languageLabel(value) {
    if (!value || value === "auto") return "감지된 언어";
    const given = state.languages.find((item) => item.value === value)?.label;
    if (given) return given;
    try { return displayNames?.of(value) || value; } catch { return value; }
  }

  function position() {
    if (panel.hidden) return;
    const rect = button.getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - panel.getBoundingClientRect().height - 8))}px`;
  }

  function closeOptions() {
    dropdowns.forEach((dropdown) => dropdown.destroy());
    dropdowns = [];
    options.hidden = true;
    optionsButton.setAttribute("aria-expanded", "false");
    position();
  }

  function close({ refocus = false } = {}) {
    if (panel.hidden) return;
    closeOptions();
    if (nativePopover && panel.matches(":popover-open")) panel.hidePopover();
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus && !button.hidden) button.focus({ preventScroll: true });
  }

  function open({ focus = true } = {}) {
    if (disposed || !state.visible || !panel.hidden) return;
    panel.hidden = false;
    if (nativePopover) panel.showPopover();
    button.setAttribute("aria-expanded", "true");
    position();
    if (focus) (state.status === "translated" ? original : translated).focus({ preventScroll: true });
  }

  function update(next) {
    if (disposed) return;
    state = { ...state, ...next };
    state.languages = Array.isArray(state.languages) ? state.languages : [];
    button.hidden = !state.visible;
    if (!state.visible) close();
    const busy = state.status === "translating";
    const isTranslated = state.status === "translated";
    const sourceName = languageLabel(state.sourceLanguage);
    const targetName = languageLabel(state.targetLanguage);
    button.classList.toggle("translated", isTranslated);
    button.title = isTranslated ? `${targetName}로 번역됨` : "이 페이지 번역";
    panel.setAttribute("aria-busy", String(busy));
    original.textContent = sourceName;
    original.setAttribute("aria-label", `${sourceName} 원문 보기`);
    translated.textContent = targetName;
    translated.setAttribute("aria-label", `${targetName}로 번역`);
    original.setAttribute("aria-pressed", String(!isTranslated));
    translated.setAttribute("aria-pressed", String(isTranslated));
    original.disabled = busy;
    translated.disabled = busy;
    status.textContent = busy ? "번역 중…" : state.status === "error" ? (state.error || "이 페이지를 번역하지 못했습니다.")
      : isTranslated ? `${targetName}로 번역했습니다.` : "페이지를 번역하시겠습니까?";
    status.classList.toggle("error", state.status === "error");
    retry.hidden = state.status !== "error";
    retry.disabled = busy;
    for (const input of panel.querySelectorAll("[data-translate-preference]")) {
      const key = input.dataset.translatePreference;
      input.checked = Boolean(state[key]);
      input.disabled = busy || (key !== "neverSite" && state.sourceLanguage === "auto");
      if (key !== "neverSite") input.nextElementSibling.textContent = key === "alwaysLanguage" ? `${sourceName} 항상 번역` : `${sourceName} 번역 안 함`;
    }
    if (dropdowns.length) {
      const serialized = JSON.stringify(state.languages);
      if (serialized !== languageItems) {
        dropdowns[0].setItems([{ value: "auto", label: "자동 감지" }, ...state.languages.filter((item) => item.value !== "auto")]);
        dropdowns[1].setItems(state.languages.filter((item) => item.value !== "auto"));
        languageItems = serialized;
      }
      dropdowns[0].setValue(state.sourceLanguage);
      dropdowns[1].setValue(state.targetLanguage);
      dropdowns.forEach((dropdown) => { dropdown.el.querySelector("button").disabled = busy; });
    }
    optionsButton.disabled = busy;
    position();
  }

  listen(button, "click", () => { if (panel.hidden) open(); else close({ refocus: true }); });
  listen(original, "click", () => onRestore?.());
  listen(translated, "click", () => onTranslate?.());
  listen(retry, "click", () => onTranslate?.());
  listen(panel.querySelector('[data-translate-action="close"]'), "click", () => close({ refocus: true }));
  listen(optionsButton, "click", () => {
    if (!options.hidden) { closeOptions(); return; }
    dropdowns = [
      createDropdown({ items: [], value: state.sourceLanguage, ariaLabel: "페이지 언어", onChange: (value) => onSourceChange?.(value) }),
      createDropdown({ items: [], value: state.targetLanguage, ariaLabel: "번역 언어", onChange: (value) => onTargetChange?.(value) }),
    ];
    panel.querySelector('[data-translate-language="source"]').append(dropdowns[0].el);
    panel.querySelector('[data-translate-language="target"]').append(dropdowns[1].el);
    languageItems = "";
    options.hidden = false;
    optionsButton.setAttribute("aria-expanded", "true");
    update({});
  });
  for (const input of panel.querySelectorAll("[data-translate-preference]")) {
    listen(input, "change", () => onPreference?.(input.dataset.translatePreference, input.checked));
  }
  listen(document, "pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  }, { capture: true });
  listen(document, "keydown", (event) => {
    if (panel.hidden || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close({ refocus: panel.contains(document.activeElement) });
  });
  listen(document, "focusin", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== button) close();
  });
  listen(window, "resize", position);
  listen(window, "scroll", position, { capture: true });
  return {
    update, open, close,
    dispose() {
      close();
      disposed = true;
      events.abort();
      button.remove();
      panel.remove();
    },
  };
}

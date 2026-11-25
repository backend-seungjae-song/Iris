const { ipcRenderer } = require("electron");

// 프레임 preload는 각 사이트 문서와 분리된 실행 환경에서 동작
if (location.protocol === "http:" || location.protocol === "https:") {
  const allowedTypes = new Set(["text", "search", "email", "tel", "url", "number"]);
  const sensitiveName = /card|cc-num|cvc|cvv|otp|pin|ssn|passwd|password|secret|token|주민/i;
  const menuKeys = new Set(["ArrowUp", "ArrowDown", "Enter", "Escape"]);
  const maxSubmitEntries = 50;
  const edited = new WeakSet();
  const excluded = new WeakSet();
  const typeChanges = new MutationObserver(rememberPasswordFields);
  typeChanges.observe(document, { subtree: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });
  const frameToken = globalThis.crypto.randomUUID?.() || Array.from(
    globalThis.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(36)
  ).join("-");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let requestId = 0;
  let current;
  let submittedByClick;

  function looksLikeCard(value) {
    if (!/^[\d\s-]+$/.test(value)) return false;
    const digits = value.replace(/[\s-]/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
      const digit = Number(digits[i]);
      const doubled = digit * 2;
      sum += (digits.length - 1 - i) % 2 ? doubled - (doubled > 9 ? 9 : 0) : digit;
    }
    return sum % 10 === 0;
  }

  function rememberPasswordFields(records) {
    for (const { target, oldValue } of records) {
      if (target instanceof HTMLInputElement && (target.type === "password" || oldValue?.toLowerCase() === "password")) {
        excluded.add(target);
      }
    }
  }

  function autocompleteExcluded(field) {
    const autocomplete = (field.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/);
    return field.form?.getAttribute("autocomplete")?.toLowerCase().trim() === "off"
      || autocomplete.some((token) => token === "off" || token === "one-time-code" || token.startsWith("cc-")
        || token === "new-password" || token === "current-password");
  }

  function fieldKey(field, value) {
    if (!allowedTypes.has(field.type) || excluded.has(field) || field.isContentEditable
      || field.matches(":disabled") || field.readOnly) return "";
    if (!field.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || autocompleteExcluded(field)) return "";
    if (sensitiveName.test(field.name) || sensitiveName.test(field.id)
      || value.length > 200 || looksLikeCard(value)) return "";
    return (field.name.trim() || field.id.trim()).toLowerCase();
  }

  function entry(field) {
    if (!edited.has(field)) return null;
    const value = field.value;
    const key = typeof value === "string" && value.trim() ? fieldKey(field, value) : "";
    return key ? { key, value } : null;
  }

  function submit(form, fromClick) {
    if (!(form instanceof HTMLFormElement)) return;
    rememberPasswordFields(typeChanges.takeRecords());
    const entries = [];
    for (const field of form.elements) {
      const captured = entry(field);
      if (captured) entries.push(captured);
      if (entries.length === maxSubmitEntries) break;
    }
    if (!entries.length) return;
    const signature = JSON.stringify(entries);
    if (fromClick) {
      const click = { form, signature };
      submittedByClick = click;
      // 기본 submit은 클릭과 같은 작업에서 발생
      setTimeout(() => { if (submittedByClick === click) submittedByClick = null; }, 0);
    } else {
      const click = submittedByClick;
      submittedByClick = null;
      if (click?.form === form && click.signature === signature) return;
    }
    ipcRenderer.sendToHost("ac-fh-submit", { entries });
  }

  function hide() {
    if (!current) return;
    const { fieldId } = current;
    current = null;
    ipcRenderer.sendToHost("ac-fh-hide", { fieldId });
  }

  function fieldRect(field) {
    let { left, top, width, height } = field.getBoundingClientRect();
    try {
      for (let frame = window; frame !== frame.top; frame = frame.parent) {
        const boundary = frame.frameElement;
        if (!boundary) return null;
        const rect = boundary.getBoundingClientRect();
        left += rect.left + boundary.clientLeft;
        top += rect.top + boundary.clientTop;
      }
    } catch {
      return null;
    }
    return { left, top, width, height };
  }

  function reportField(event) {
    if (!event.isTrusted) return;
    const field = event.composedPath()[0];
    if (!(field instanceof HTMLInputElement)) { hide(); return; }
    rememberPasswordFields(typeChanges.takeRecords());
    if (field.type === "password" || (event.type === "input" && autocompleteExcluded(field))) excluded.add(field);
    if (event.type === "input") edited.add(field);
    if (!field.matches(":focus")) { hide(); return; }
    const prefix = field.value;
    const key = fieldKey(field, prefix);
    const rect = key && fieldRect(field);
    if (!rect || rect.width <= 0 || rect.height <= 0) { hide(); return; }
    const fieldId = `${frameToken}:${++requestId}`;
    current = { field, fieldId, key, prefix, open: false, selected: false };
    ipcRenderer.sendToHost("ac-fh-field", { fieldId, key, prefix, rect });
  }

  window.addEventListener("submit", (event) => {
    if (event.isTrusted) submit(event.target, false);
  }, true);
  window.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const button = event.composedPath()[0]?.closest?.("button, input");
    if (button?.form?.contains(button) && !button.matches(":disabled")
      && (button.type === "submit" || button.type === "image")) submit(button.form, true);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.isComposing) return;
    const field = event.composedPath()[0];
    const key = event.shiftKey && event.key === "Delete" ? "Shift+Delete" : event.key;
    if (current?.open && current.field === field && (menuKeys.has(key) || key === "Shift+Delete")
      && (key !== "Enter" || current.selected)) {
      event.preventDefault();
      ipcRenderer.sendToHost("ac-fh-key", { fieldId: current.fieldId, key });
      return;
    }
    if (event.key === "Enter" && field instanceof HTMLInputElement && !field.form) {
      rememberPasswordFields(typeChanges.takeRecords());
      const captured = entry(field);
      if (captured) ipcRenderer.sendToHost("ac-fh-submit", { entries: [captured] });
    }
  }, true);
  window.addEventListener("focus", reportField, true);
  window.addEventListener("input", reportField, true);
  for (const type of ["blur", "scroll", "resize", "pagehide"]) {
    window.addEventListener(type, hide, true);
  }

  ipcRenderer.on("ac-fh-state", (_event, payload) => {
    if (current && payload?.fieldId === current.fieldId) {
      current.open = payload.open === true;
      current.selected = current.open && payload.selected === true;
    }
  });
  ipcRenderer.on("ac-fh-fill", (_event, payload) => {
    if (!current?.open || payload?.fieldId !== current.fieldId) return;
    rememberPasswordFields(typeChanges.takeRecords());
    const { field, prefix, key } = current;
    const { value } = payload;
    if (typeof value !== "string" || !value.trim() || field.value !== prefix
      || !field.matches(":focus") || fieldKey(field, value) !== key) return;
    hide();
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// 대화에서 받은 A2UI 컴포넌트를 콘솔 탭에 표시
// - 외부 문자열은 모두 textContent 로만 넣어 스크립트 주입을 차단
import { createDropdown } from "../core/dropdown.js";

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function splitPath(rawPath) {
  return String(rawPath || "").replace(/^@/, "").replace(/^\/+/, "").split(/[./]/).filter(Boolean);
}

function getPath(obj, rawPath) {
  const parts = splitPath(rawPath);
  if (!parts.length || !obj || typeof obj !== "object") return undefined;
  return parts.reduce((cur, k) => (cur && typeof cur === "object" ? cur[k] : undefined), obj);
}

function setPath(obj, rawPath, value) {
  const parts = splitPath(rawPath);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function resolveVal(raw, dataModel) {
  if (typeof raw === "string" && (raw.startsWith("@") || raw.startsWith("/"))) {
    const v = getPath(dataModel, raw);
    return v === undefined || v === null ? "" : v;
  }
  return raw ?? "";
}

function bindKeyOf(comp) {
  if (comp.bind) return comp.bind;
  if (typeof comp.value === "string" && (comp.value.startsWith("@") || comp.value.startsWith("/"))) return comp.value;
  return comp.id || "";
}

const ICON_CLOSE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// A2UI Icon 컴포넌트용 고정 내장 아이콘(외부 URL·스크립트 미사용)
const CATALOG_ICONS = {
  check: '<path d="M5 13l4 4L19 7"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  warning: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2.8-2.8a5 5 0 0 0-7-7l-1.6 1.6"/><path d="M14 11a5 5 0 0 0-7.5-.5L3.7 13.3a5 5 0 0 0 7 7l1.6-1.5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
};

export function createA2uiHost({ root, onAction, onDismiss }) {
  let surfaces = [];
  let activeId = "";
  let openModal = null;                 // { close }
  let renderCleanups = [];
  const localModels = new Map();        // surfaceId → dataModel
  const tabSelection = new Map();       // `${surfaceId}:${tabKey}` → activeIndex

  function runCleanups() {
    openModal = null;
    for (const fn of renderCleanups) { try { fn(); } catch {} }
    renderCleanups = [];
  }

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (openModal) {
      e.preventDefault();
      openModal.close();
      return;
    }
  };
  root.addEventListener("keydown", onKeyDown);

  function activeSurface() {
    if (!surfaces.length) return null;
    return surfaces.find((s) => s.surfaceId === activeId) || surfaces[surfaces.length - 1];
  }

  function modelOf(surface) {
    let model = localModels.get(surface.surfaceId);
    if (!model) {
      model = structuredClone(surface.dataModel || {});
      localModels.set(surface.surfaceId, model);
    }
    return model;
  }

  function renderNode(comp, surface, model, refreshBindings, modalHost, seqRef, inModalTrigger = false) {
    if (!comp || typeof comp !== "object") return null;
    const t = comp.type;
    if (t === "Divider") return el("hr", "a2ui-div");

    if (t === "Text") {
      const v = comp.variant || "body";
      const safeV = ["h1", "h2", "h3", "caption", "code"].includes(v) ? v : "body";
      const node = el(safeV === "code" ? "pre" : "div", `a2ui-text a2ui-text-${safeV}`);
      node.dataset.a2uiBind = typeof comp.text === "string" && (comp.text.startsWith("@") || comp.text.startsWith("/")) ? comp.text : "";
      node.textContent = String(resolveVal(comp.text, model));
      return node;
    }

    if (t === "Icon") {
      const paths = CATALOG_ICONS[comp.name] || CATALOG_ICONS.sparkle;
      const tone = ["accent", "ok", "warn", "danger"].includes(comp.tone) ? ` a2ui-icon-${comp.tone}` : "";
      const wrap = el("span", `a2ui-icon${tone}`);
      wrap.setAttribute("aria-hidden", "true");
      wrap.innerHTML = `<svg class="i" viewBox="0 0 24 24">${paths}</svg>`;
      return wrap;
    }

    if (t === "Image") {
      if (typeof comp.url !== "string" || !/^https?:\/\//i.test(comp.url)) return null;
      const frame = el("div", "a2ui-img-wrap");
      const img = document.createElement("img");
      img.className = `a2ui-img${comp.fit === "contain" ? " fit-contain" : ""}`;
      img.src = comp.url;
      img.alt = comp.alt ? String(comp.alt) : "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      frame.appendChild(img);
      return frame;
    }

    if (t === "Badge") {
      const tone = ["accent", "ok", "warn", "danger"].includes(comp.tone) ? comp.tone : "default";
      const node = el("span", `a2ui-badge a2ui-tone-${tone}`);
      node.textContent = String(resolveVal(comp.text ?? comp.label, model));
      return node;
    }

    if (t === "KeyValue") {
      const list = el("dl", "a2ui-kv");
      for (const item of Array.isArray(comp.items) ? comp.items : []) {
        const row = el("div", "a2ui-kv-row");
        row.appendChild(el("dt", "a2ui-kv-k", item.label));
        const dd = el("dd", `a2ui-kv-v${item.tone ? ` a2ui-tone-${item.tone}` : ""}`);
        dd.textContent = String(resolveVal(item.value, model));
        row.appendChild(dd);
        list.appendChild(row);
      }
      return list;
    }

    if (t === "Table") {
      const wrap = el("div", "a2ui-table-wrap");
      const table = el("table", "a2ui-table");
      const cols = Array.isArray(comp.columns) ? comp.columns : [];
      if (cols.length) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const c of cols) tr.appendChild(el("th", "", c.label || c.key));
        thead.appendChild(tr);
        table.appendChild(thead);
      }
      const tbody = document.createElement("tbody");
      for (const r of Array.isArray(comp.rows) ? comp.rows : []) {
        const tr = document.createElement("tr");
        if (Array.isArray(r)) {
          for (const cell of r) tr.appendChild(el("td", "", cell ?? ""));
        } else if (r && typeof r === "object") {
          for (const c of cols) tr.appendChild(el("td", "", r[c.key] ?? ""));
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }

    if (t === "Progress") {
      const max = typeof comp.max === "number" && comp.max > 0 ? comp.max : 100;
      const rawVal = Number(resolveVal(comp.value, model)) || 0;
      const pct = Math.max(0, Math.min(100, Math.round((rawVal / max) * 100)));
      const box = el("div", "a2ui-progress");
      const top = el("div", "a2ui-progress-top");
      top.appendChild(el("span", "", comp.label || ""));
      top.appendChild(el("span", "a2ui-mono", `${pct}%`));
      const track = el("div", "a2ui-progress-track");
      const fill = el("div", "a2ui-progress-fill");
      fill.style.setProperty("--pct", String(pct / 100));
      track.appendChild(fill);
      box.append(top, track);
      return box;
    }

    if (t === "TextField") {
      const wrap = el("label", "a2ui-field");
      if (comp.label) wrap.appendChild(el("span", "a2ui-field-lbl", comp.label));
      const key = bindKeyOf(comp);
      const input = document.createElement(comp.multiline ? "textarea" : "input");
      input.className = "a2ui-input";
      if (!comp.multiline) input.type = "text";
      else input.rows = 3;
      if (comp.placeholder) input.placeholder = comp.placeholder;
      if (comp.disabled) input.disabled = true;
      const initial = key ? getPath(model, key) : resolveVal(comp.value, model);
      if (initial !== undefined && initial !== null) input.value = String(initial);
      input.addEventListener("input", () => {
        if (key) { setPath(model, key, input.value); refreshBindings(); }
      });
      wrap.appendChild(input);
      return wrap;
    }

    if (t === "Slider") {
      const wrap = el("label", "a2ui-field");
      const key = bindKeyOf(comp);
      const min = typeof comp.min === "number" ? comp.min : 0;
      const max = typeof comp.max === "number" && comp.max > min ? comp.max : 100;
      const step = typeof comp.step === "number" && comp.step > 0 ? comp.step : 1;
      const initRaw = key ? getPath(model, key) : resolveVal(comp.value, model);
      const initVal = Number.isFinite(Number(initRaw)) ? Number(initRaw) : min;
      const head = el("div", "a2ui-slider-head");
      head.appendChild(el("span", "a2ui-field-lbl", comp.label || "값"));
      const readout = el("span", "a2ui-slider-val", `${initVal}${comp.unit || ""}`);
      head.appendChild(readout);

      const input = document.createElement("input");
      input.type = "range";
      input.className = "a2ui-slider";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(initVal);
      if (comp.disabled) input.disabled = true;
      input.addEventListener("input", () => {
        const next = Number(input.value);
        readout.textContent = `${next}${comp.unit || ""}`;
        if (key) { setPath(model, key, next); refreshBindings(); }
      });
      wrap.append(head, input);
      return wrap;
    }

    if (t === "DateTimeInput") {
      const wrap = el("label", "a2ui-field");
      if (comp.label) wrap.appendChild(el("span", "a2ui-field-lbl", comp.label));
      const key = bindKeyOf(comp);
      const enableDate = comp.enableDate !== false;
      const enableTime = comp.enableTime === true;
      const input = document.createElement("input");
      input.className = "a2ui-input a2ui-datetime";
      input.type = enableDate && enableTime ? "datetime-local" : enableTime ? "time" : "date";
      if (comp.disabled) input.disabled = true;
      const init = key ? getPath(model, key) : resolveVal(comp.value, model);
      if (init !== undefined && init !== null) input.value = String(init);
      input.addEventListener("change", () => {
        if (key) { setPath(model, key, input.value); refreshBindings(); }
      });
      wrap.appendChild(input);
      return wrap;
    }

    if (t === "ChoicePicker" || t === "Select" || t === "MultipleChoice") {
      const wrap = el("div", "a2ui-field");
      if (comp.label) wrap.appendChild(el("span", "a2ui-field-lbl", comp.label));
      const key = bindKeyOf(comp);
      const opts = Array.isArray(comp.options) ? comp.options : [];
      const maxPick = typeof comp.maxAllowedSelections === "number" ? comp.maxAllowedSelections : 0;
      const multi = comp.multiple === true || maxPick > 1;
      const curRaw = key ? getPath(model, key) : resolveVal(comp.value, model);

      if (!multi && comp.variant === "dropdown") {
        const items = opts.map((o) => ({ value: o.value, label: o.label, ...(o.description ? { sub: o.description } : {}) }));
        if (!items.some((i) => i.value === (curRaw ?? ""))) {
          items.unshift({ value: "", label: comp.placeholder || "선택하세요..." });
        }
        const dd = createDropdown({
          items,
          value: curRaw ?? "",
          ariaLabel: comp.label || "선택",
          className: "a2ui-dd",
          showSub: true,
          onChange(next) {
            if (key) { setPath(model, key, next); refreshBindings(); }
          },
        });
        renderCleanups.push(() => dd.destroy());
        wrap.appendChild(dd.el);
        return wrap;
      }

      const isChips = comp.variant === "chips";
      const group = el("div", isChips ? "a2ui-chips" : "a2ui-select");
      let fallback = multi
        ? (Array.isArray(curRaw) ? curRaw.map(String) : curRaw ? [String(curRaw)] : [])
        : (curRaw == null ? "" : String(curRaw));

      const readSelected = () => {
        const v = key ? getPath(model, key) : fallback;
        if (multi) return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
        return v == null ? "" : String(v);
      };

      const syncSelected = () => {
        const now = readSelected();
        for (const btn of group.querySelectorAll("button")) {
          const on = multi ? now.includes(btn.dataset.val) : btn.dataset.val === now;
          btn.classList.toggle("on", on);
          btn.setAttribute("aria-pressed", String(on));
        }
      };

      for (const opt of opts) {
        const btn = el("button", isChips ? "a2ui-chip" : "a2ui-opt");
        btn.type = "button";
        btn.dataset.val = opt.value;
        btn.appendChild(el("span", isChips ? "" : "a2ui-opt-lbl", opt.label));
        if (!isChips && opt.description) btn.appendChild(el("span", "a2ui-opt-desc", opt.description));
        btn.addEventListener("click", () => {
          let next;
          if (multi) {
            const set = new Set(readSelected());
            if (set.has(opt.value)) set.delete(opt.value);
            else {
              if (maxPick > 0 && set.size >= maxPick) set.delete(set.values().next().value);
              set.add(opt.value);
            }
            next = [...set];
          } else {
            next = opt.value;
          }
          fallback = next;
          if (key) { setPath(model, key, next); refreshBindings(); }
          syncSelected();
        });
        group.appendChild(btn);
      }
      syncSelected();
      wrap.appendChild(group);
      return wrap;
    }

    if (t === "CheckBox" || t === "Checkbox") {
      const wrap = el("label", "a2ui-check");
      const key = bindKeyOf(comp);
      const box = document.createElement("input");
      box.type = "checkbox";
      const init = key ? getPath(model, key) : resolveVal(comp.checked ?? comp.value, model);
      box.checked = Boolean(init);
      if (comp.disabled) box.disabled = true;
      box.addEventListener("change", () => {
        if (key) { setPath(model, key, box.checked); refreshBindings(); }
      });
      wrap.appendChild(box);
      wrap.appendChild(el("span", "", comp.label || ""));
      return wrap;
    }

    if (t === "Button") {
      const variant = comp.variant === "primary" ? "cc-btn cc-btn-pri"
        : comp.variant === "danger" ? "cc-btn cc-btn-danger"
          : (comp.variant === "ghost" || comp.variant === "borderless") ? "cc-btn cc-btn-txt"
            : "cc-btn";
      const btn = el("button", `${variant} a2ui-btn`);
      btn.type = "button";
      const hasInlineLabel = comp.label !== undefined || comp.text !== undefined;
      if (hasInlineLabel) {
        btn.textContent = String(resolveVal(comp.label ?? comp.text, model));
      } else if (Array.isArray(comp.children) && comp.children.length) {
        for (const child of comp.children) {
          const n = renderNode(child, surface, model, refreshBindings, modalHost, seqRef);
          if (n) btn.appendChild(n);
        }
      } else {
        btn.textContent = "확인";
      }
      if (comp.disabled) btn.disabled = true;
      if (!inModalTrigger) {
        btn.addEventListener("click", () => {
          onAction?.({
            surfaceId: surface.surfaceId,
            title: surface.title,
            action: comp.action || btn.textContent.trim() || "click",
            payload: comp.payload,
            dataModel: structuredClone(model),
          });
          if (comp.closeOnAction) onDismiss?.(surface.surfaceId);
        });
      }
      return btn;
    }

    if (t === "Tabs") {
      const tabs = Array.isArray(comp.tabs) ? comp.tabs : [];
      if (!tabs.length) return null;
      const tabKey = `${surface.surfaceId}:${comp.id || ++seqRef.n}`;
      const wrap = el("div", "a2ui-tabs-box");
      const bar = el("div", "a2ui-tabs-bar");
      bar.setAttribute("role", "tablist");
      const panel = el("div", "a2ui-tabs-panel");
      panel.setAttribute("role", "tabpanel");

      const drawTab = () => {
        const idx = Math.max(0, Math.min(tabs.length - 1, tabSelection.get(tabKey) || 0));
        [...bar.children].forEach((b, i) => {
          const on = i === idx;
          b.classList.toggle("on", on);
          b.setAttribute("aria-selected", String(on));
        });
        panel.textContent = "";
        for (const child of tabs[idx]?.children || []) {
          const n = renderNode(child, surface, model, refreshBindings, modalHost, seqRef);
          if (n) panel.appendChild(n);
        }
      };

      tabs.forEach((tab, i) => {
        const btn = el("button", "a2ui-tabs-btn", tab.title || `탭 ${i + 1}`);
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.addEventListener("click", () => {
          tabSelection.set(tabKey, i);
          drawTab();
        });
        bar.appendChild(btn);
      });
      drawTab();
      wrap.append(bar, panel);
      return wrap;
    }

    if (t === "Modal") {
      const trigger = comp.entryPointChild
        ? renderNode(comp.entryPointChild, surface, model, refreshBindings, modalHost, seqRef, true)
        : el("button", "cc-btn a2ui-btn", comp.triggerLabel || comp.title || "상세 보기");
      if (!trigger) return null;
      if (trigger.tagName === "BUTTON") trigger.type = "button";

      const openDialog = () => {
        if (openModal) openModal.close();
        const host = modalHost;
        const backdrop = el("div", "a2ui-modal-backdrop");
        const dialog = el("div", "a2ui-modal");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        const head = el("div", "a2ui-modal-head");
        head.appendChild(el("span", "a2ui-modal-title", comp.title || "상세 내용"));
        const closeBtn = el("button", "cc-btn cc-btn-icon");
        closeBtn.type = "button";
        closeBtn.setAttribute("aria-label", "모달 닫기");
        closeBtn.innerHTML = ICON_CLOSE;

        const body = el("div", "a2ui-modal-body");
        const contentList = comp.contentChild ? [comp.contentChild] : (Array.isArray(comp.children) ? comp.children : []);
        for (const c of contentList) {
          const n = renderNode(c, surface, model, refreshBindings, modalHost, seqRef);
          if (n) body.appendChild(n);
        }

        const close = () => {
          backdrop.remove();
          if (openModal?.backdrop === backdrop) openModal = null;
          if (trigger.focus) trigger.focus();
        };
        closeBtn.addEventListener("click", close);
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
        head.appendChild(closeBtn);
        dialog.append(head, body);
        backdrop.appendChild(dialog);
        host.appendChild(backdrop);
        openModal = { backdrop, close };
        renderCleanups.push(() => backdrop.remove());
        closeBtn.focus();
      };

      trigger.addEventListener("click", openDialog);
      return trigger;
    }

    if (t === "Row" || t === "Column" || t === "Card" || t === "List") {
      const cls = t === "Row" ? "a2ui-row" : t === "Card" ? "a2ui-card" : t === "List" ? "a2ui-list" : "a2ui-col";
      const box = el("div", cls);
      if (t === "Card" && comp.title) box.appendChild(el("div", "a2ui-card-t", comp.title));
      for (const child of Array.isArray(comp.children) ? comp.children : []) {
        const node = renderNode(child, surface, model, refreshBindings, modalHost, seqRef);
        if (node) box.appendChild(node);
      }
      if (t === "List" && (!comp.children || !comp.children.length) && Array.isArray(comp.items)) {
        for (const item of comp.items) {
          const row = el("div", "a2ui-list-item");
          row.appendChild(el("span", "", item.label || ""));
          if (item.value !== "") row.appendChild(el("span", "a2ui-muted", String(resolveVal(item.value, model))));
          box.appendChild(row);
        }
      }
      return box;
    }
    return null;
  }

  function surfaceSelector(surface) {
    const tabs = el("div", "a2ui-tabs");
    for (const s of surfaces) {
      const tab = el("button", `a2ui-tab${s.surfaceId === surface.surfaceId ? " on" : ""}`, s.title || s.surfaceId);
      tab.type = "button";
      tab.addEventListener("click", () => { activeId = s.surfaceId; render(); });
      tabs.appendChild(tab);
    }
    return tabs;
  }

  function renderBody(surface, modalHost) {
    const body = el("div", "a2ui-body");
    const container = el("div", "a2ui-canvas");
    const model = modelOf(surface);
    const seqRef = { n: 0 };
    const refreshBindings = () => {
      for (const node of body.querySelectorAll("[data-a2ui-bind]")) {
        const path = node.dataset.a2uiBind;
        if (path) node.textContent = String(resolveVal(path, model));
      }
    };
    for (const comp of Array.isArray(surface.components) ? surface.components : []) {
      const node = renderNode(comp, surface, model, refreshBindings, modalHost, seqRef);
      if (node) container.appendChild(node);
    }
    body.appendChild(container);
    return body;
  }

  function render() {
    runCleanups();
    root.replaceChildren();
    const surface = activeSurface();
    if (!surface) return;
    activeId = surface.surfaceId;
    root.append(renderBody(surface, root));
    if (surfaces.length > 1) root.append(surfaceSelector(surface));
  }

  return {
    setSurfaces(nextList) {
      const prevIds = new Set(surfaces.map((s) => s.surfaceId));
      surfaces = Array.isArray(nextList) ? nextList : [];
      const keep = new Set(surfaces.map((s) => s.surfaceId));
      for (const id of [...localModels.keys()]) if (!keep.has(id)) {
        localModels.delete(id);
        for (const k of [...tabSelection.keys()]) if (k.startsWith(`${id}:`)) tabSelection.delete(k);
      }
      for (const s of surfaces) {
        if (!prevIds.has(s.surfaceId)) localModels.set(s.surfaceId, structuredClone(s.dataModel || {}));
        else {
          const cur = localModels.get(s.surfaceId) || {};
          localModels.set(s.surfaceId, { ...(s.dataModel || {}), ...cur });
        }
      }
      render();
    },
    clear() {
      surfaces = [];
      activeId = "";
      localModels.clear();
      tabSelection.clear();
      render();
    },
  };
}

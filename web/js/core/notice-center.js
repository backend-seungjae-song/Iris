const active = new Map();
const keyed = new Map();
let sequence = 0;
let expanded = false;
let host;
let noticeList;
let more;

const DURATION = { ok: 4000, info: 4000, warn: 6000, err: 12000 };
const ICON = {
  ok: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  info: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { d: "M12 11v5M12 8v.2" }]],
  warn: [["path", { d: "M12 4.5l8.5 15h-17z" }], ["path", { d: "M12 10.5v4M12 17.3v.2" }]],
  err: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { d: "M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" }]],
  progress: [["path", { d: "M20 12a8 8 0 1 1-8-8" }]],
};

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
}

function addButton(parent, label, handler, className = "") {
  const button = el("button", className, label);
  button.type = "button";
  button.addEventListener("click", handler);
  parent.append(button);
  return button;
}

function noticeIcon(kind) {
  const icon = el("span", "iris-notice-icon");
  icon.setAttribute("aria-hidden", "true");
  if (["ask", "approve", "waiting"].includes(kind)) {
    icon.append(el("span", "iris-notice-wait-mark"));
    return icon;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const [tag, attrs] of ICON[kind] || ICON.info) {
    const part = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, value);
    svg.append(part);
  }
  icon.append(svg);
  return icon;
}

function ensureHost() {
  if (host) return;
  host = el("section", "iris-notices");
  host.setAttribute("aria-label", "Iris 알림");
  noticeList = el("div", "iris-notices-list");
  more = addButton(host, "", () => { expanded = !expanded; render(); }, "iris-notices-more");
  more.hidden = true; // 알림 없이 anchorNotices 로 만들면 render 전까지 빈 버튼이 창 머리 줄을 덮음
  host.prepend(noticeList);
  document.body.append(host);
}

// 숨겨진 영역은 건너뛰고 처음 보이는 기준 요소에 알림을 맞춘다.
let anchors = [];
// 넘침을 자르는 조상(접힌 채팅 영역 등) 안에서 실제 보이는 부분
function shownRect(node) {
  if (!node?.isConnected) return null;
  let { left, right, top, bottom } = node.getBoundingClientRect();
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none") return null;
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left); right = Math.min(right, box.right);
    top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
  }
  return right - left > 0 && bottom - top > 0 ? { right, top, bottom, width: right - left } : null;
}
function place() {
  if (!host) return;
  const anchor = anchors.map(({ element, edge }) => ({ rect: shownRect(element), edge })).find(({ rect }) => rect);
  const rect = anchor?.rect;
  if (!rect) { host.style.removeProperty("--notice-top"); host.style.removeProperty("--notice-right"); host.style.removeProperty("--notice-width"); return; }
  host.style.setProperty("--notice-top", `${Math.round(rect[anchor.edge] + 8)}px`);
  host.style.setProperty("--notice-right", `${Math.max(12, Math.round(innerWidth - rect.right + 12))}px`);
  host.style.setProperty("--notice-width", `${Math.round(Math.min(340, Math.max(240, rect.width - 24)))}px`);
}
export function anchorNotices(elements) {
  anchors = elements.filter(Boolean).map((entry) => entry.element !== undefined ? entry : { element: entry, edge: "bottom" });
  ensureHost();
  const observer = new ResizeObserver(place);
  for (const { element } of anchors) if (element) observer.observe(element);
  addEventListener("resize", place);
  place();
}

function dismiss(id) {
  const item = active.get(id);
  if (!item) return;
  active.delete(id);
  if (item.key && keyed.get(item.key) === id) keyed.delete(item.key);
  render();
}

function card(item) {
  const wait = item.kind === "ask" || item.kind === "approve" || item.kind === "waiting";
  const card = el("article", `iris-notice iris-notice-${item.kind}`);
  card.dataset.id = item.id;
  card.setAttribute("role", wait || item.kind === "err" || item.kind === "warn" ? "alert" : "status");
  card.tabIndex = wait ? 0 : -1;
  const head = el("div", "iris-notice-head");
  head.append(noticeIcon(item.kind));
  head.append(el("strong", "iris-notice-title", item.title));
  if ((!wait || item.expired) && item.kind !== "progress") addButton(head, "×", () => dismiss(item.id), "iris-notice-close").setAttribute("aria-label", "알림 닫기");
  card.append(head);
  if (item.source) {
    const source = el("div", "iris-notice-source");
    source.append(el("span", "iris-notice-ai", "AI"), el("span", "", item.source));
    card.append(source);
  }
  if (item.body) card.append(el("p", "iris-notice-body", item.body));
  if (item.detail) {
    const detail = el("div", "iris-notice-detail");
    detail.append(el("pre", "iris-notice-detail-text", item.detail));
    detail.addEventListener("click", (event) => { if (!event.target.closest("button")) detail.classList.toggle("expanded"); });
    addButton(detail, "복사", () => navigator.clipboard?.writeText(item.detail));
    card.append(detail);
  }
  if (Array.isArray(item.items) && item.items.length) {
    const values = el("ul", "iris-notice-items");
    for (const value of item.items.slice(0, 10)) values.append(el("li", "", value));
    if (item.total > item.items.length) values.append(el("li", "", `외 ${item.total - item.items.length}칸`));
    card.append(values);
  }
  if (item.irreversible) card.append(el("p", "iris-notice-irreversible", "되돌릴 수 없음"));
  if (item.kind === "progress") {
    const bar = el("div", "iris-notice-progress");
    if (Number.isFinite(item.p)) bar.style.setProperty("--notice-progress", String(Math.max(0, Math.min(1, item.p))));
    else bar.classList.add("indeterminate");
    bar.append(el("span"));
    card.append(bar);
  }
  if (item.round > 1) card.append(el("small", "iris-notice-round", `다시 기다리는 중 · ${item.round}회차`));
  if (wait && item.deadline && !item.expired) {
    const seconds = Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000));
    card.append(el("small", "iris-notice-left", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 남음`));
  }
  if (item.expired) card.append(el("small", "iris-notice-expired", "만료됨"));
  const actions = el("div", "iris-notice-actions");
  if (item.go && !item.expired) addButton(actions, item.went ? "그 탭에 있음" : item.go.label, () => {
    item.go.run(); item.went = true; item.onGo?.(); render();
  });
  if (wait && item.kind !== "waiting" && !item.expired) {
    const choices = item.kind === "approve" ? [item.approveLabel || "승인", item.denyLabel || "취소"]
      : item.choices?.length ? item.choices : ["다 했어요", "못 하겠어요"];
    choices.forEach((choice, index) => {
      const button = addButton(actions, choice, () => {
        const sent = item.onAnswer?.(choice);
        if (sent !== false && item.dismissOnAnswer !== false) dismiss(item.id);
      }, index === 0 ? "primary" : "");
      button.setAttribute("aria-keyshortcuts", String(index + 1));
    });
    card.addEventListener("keydown", (event) => {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < choices.length) { event.preventDefault(); actions.children[item.go ? index + 1 : index].click(); }
    });
  }
  if (actions.childElementCount) card.append(actions);
  if (!wait && item.kind !== "progress") {
    // 줄어드는 모양은 CSS 애니메이션(남은 시간 동안 한 번에). 인라인 값은 모션을 끈 때의 0.2초 단위 표시
    const life = el("span", "iris-notice-life");
    const left = Math.max(0, item.remaining / item.duration);
    life.style.transform = `scaleX(${left})`;
    life.style.setProperty("--life-from", String(left));
    life.style.animationDuration = `${Math.max(0, item.remaining)}ms`;
    card.append(life);
  }
  return card;
}

function render() {
  ensureHost();
  place();
  const items = [...active.values()];
  const waits = items.filter((item) => ["ask", "approve", "waiting"].includes(item.kind));
  const rest = items.filter((item) => !["ask", "approve", "waiting"].includes(item.kind)).reverse();
  noticeList.replaceChildren();
  if (waits.length) noticeList.append(el("div", "iris-notice-section", `답을 기다리는 것 · ${waits.length}`));
  for (const item of waits) noticeList.append(card(item));
  if (rest.length && waits.length) noticeList.append(el("div", "iris-notice-section", "최근"));
  for (const item of (expanded ? rest : rest.slice(0, 1))) noticeList.append(card(item));
  more.hidden = rest.length < 2;
  more.textContent = expanded ? "알림 접기" : `외 ${rest.length - 1}건 · 알림 펼치기`;
}

export function pushNotice(input) {
  ensureHost();
  const key = input.key ? String(input.key) : "";
  const id = String(input.id || (key && keyed.get(key)) || `notice-${++sequence}`);
  const old = active.get(id);
  const kind = input.kind || input.level || old?.kind || "info";
  const duration = DURATION[kind] || 0;
  const item = { ...old, ...input, id, kind, duration,
    remaining: duration,
    deadline: Object.hasOwn(input, "deadline") ? input.deadline : old?.deadline ?? null };
  if (key) { item.key = key; keyed.set(key, id); }
  active.set(id, item);
  render();
  return id;
}

export function updateNotice(id, patch) {
  const old = active.get(String(id));
  if (!old) return false;
  const kind = patch.kind || patch.level || old.kind;
  const duration = DURATION[kind] || 0;
  active.set(String(id), { ...old, ...patch, kind, duration, remaining: kind !== old.kind ? duration : old.remaining });
  render();
  return true;
}

export function expireNotice(id) { return updateNotice(id, { expired: true, deadline: null }); }
export function removeNotice(id) { dismiss(String(id)); }
export function hasNotice(id) { return active.has(String(id)); }
export function focusNotice(id) {
  const item = active.get(String(id));
  if (!item) return;
  expanded = true; render();
  noticeList.querySelector(`[data-id="${CSS.escape(item.id)}"]`)?.focus();
}

let lastTick = Date.now();
setInterval(() => {
  if (!host) return;
  const now = Date.now();
  const elapsed = Math.min(1000, now - lastTick);
  lastTick = now;
  // 영역을 접거나 옮겨도 떠 있는 알림이 따라가게
  if (active.size) place();
  const hovering = host.matches(":hover");
  let changed = false;
  for (const item of [...active.values()]) {
    if (item.kind === "progress" && item.ttl && now >= item.ttl) {
      updateNotice(item.id, { kind: "warn", title: "응답 없음", body: item.title });
      changed = true;
    } else if (item.duration && !hovering) {
      item.remaining -= elapsed;
      if (item.remaining <= 0) { dismiss(item.id); changed = true; }
    }
  }
  if (changed) render();
  else for (const item of active.values()) {
    if (item.deadline) {
      const seconds = Math.max(0, Math.ceil((item.deadline - now) / 1000));
      const label = noticeList.querySelector(`[data-id="${CSS.escape(item.id)}"] .iris-notice-left`);
      if (label) label.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 남음`;
    }
    const life = noticeList.querySelector(`[data-id="${CSS.escape(item.id)}"] .iris-notice-life`);
    if (life) life.style.transform = `scaleX(${Math.max(0, item.remaining / item.duration)})`;
  }
}, 200);

// 조작 옆 알림: 방금 한 복사의 결과를 그 자리에 꼬리 달린 색 칩으로(사용자 시안 C).
// 알림 목록(notice-center)은 특정 조작에 묶이지 않은 알림용. 기준 위치를 못 구하면 false 를 돌려 호출자가 목록으로 보냄

const DURATION = { ok: 1800, info: 2200, warn: 3500, err: 5000 };
const ICON = {
  ok: "M5 12.5l4.5 4.5L19 7.5",
  info: "M12 11v5M12 8v.2",
  warn: "M12 10.5v4M12 17.3v.2",
  err: "M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6",
};
let node;
let timer = 0;
let last = null;

// 마지막 조작 기록: 누른 점(메뉴처럼 결과가 나올 때 이미 사라진 요소 대신), 키는 그때 포커스 요소
addEventListener("pointerdown", (event) => { last = { x: event.clientX, y: event.clientY, at: Date.now() }; }, true);
addEventListener("pointerup", (event) => { if (last && !last.key) Object.assign(last, { x: event.clientX, y: event.clientY }); }, true);
addEventListener("keydown", (event) => {
  if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) last = { key: true, element: document.activeElement, at: Date.now() };
}, true);

const point = (x, y) => ({ left: x, right: x, top: y, bottom: y });

function visibleRect(element) {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

// 키 조작: 포커스 요소가 작으면 그 요소, 크면(편집 화면 전체 등) 선택 영역, 없으면 알 수 없음
function keyRect(element) {
  const rect = visibleRect(element);
  if (rect && rect.width <= 480 && rect.height <= 120) return rect;
  const selection = getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  return range && (range.width || range.height) ? range : null;
}

// near: 요소, 이벤트, {x,y}, "action"(10초 안의 마지막 조작 자리). 요소가 사라졌으면 마지막 조작 자리
function anchorRect(near) {
  if (!near) return null;
  if (near === "action") {
    if (!last || Date.now() - last.at > 10000) return null;
    return last.key ? keyRect(last.element) : point(last.x, last.y);
  }
  if (typeof Element !== "undefined" && near instanceof Element) return visibleRect(near) || anchorRect("action");
  if (typeof Event !== "undefined" && near instanceof Event) {
    const target = near.target instanceof Element ? near.target : null;
    return visibleRect(target) || (Number.isFinite(near.clientX) && (near.clientX || near.clientY) ? point(near.clientX, near.clientY) : anchorRect("action"));
  }
  if (Number.isFinite(near.x) && Number.isFinite(near.y)) return point(near.x, near.y);
  return null;
}

function hide() {
  clearTimeout(timer);
  if (node) node.hidden = true;
}

export function showActionNotice(near, { kind = "info", title = "" } = {}) {
  const rect = anchorRect(near);
  if (!rect || !title) return false;
  if (!node) {
    node = document.createElement("div");
    node.className = "action-notice";
    node.addEventListener("pointerenter", () => clearTimeout(timer));
    node.addEventListener("pointerleave", () => { timer = setTimeout(hide, 1200); });
    document.body.append(node);
  }
  const svg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[kind] || ICON.info}"/></svg>`;
  node.className = `action-notice action-notice-${DURATION[kind] ? kind : "info"}`;
  node.setAttribute("role", kind === "err" || kind === "warn" ? "alert" : "status");
  node.innerHTML = svg;
  node.append(Object.assign(document.createElement("span"), { textContent: String(title) }));
  node.hidden = false;
  // 기준 위 가운데, 꼬리가 기준을 가리킴. 위 공간이 모자라면 아래(꼬리도 위로). 창 밖으로 나가지 않게 8px 안쪽
  const width = node.offsetWidth, height = node.offsetHeight;
  const center = (rect.left + rect.right) / 2;
  const above = rect.top - height - 8;
  const left = Math.round(Math.min(innerWidth - width - 8, Math.max(8, center - width / 2)));
  node.classList.toggle("down", above < 8);
  node.style.left = `${left}px`;
  node.style.top = `${Math.round(above >= 8 ? above : Math.min(innerHeight - height - 8, rect.bottom + 8))}px`;
  node.style.setProperty("--tail", `${Math.round(Math.min(width - 10, Math.max(10, center - left)))}px`);
  node.classList.remove("in");
  void node.offsetWidth;
  node.classList.add("in");
  clearTimeout(timer);
  timer = setTimeout(hide, DURATION[kind] || DURATION.info);
  return true;
}

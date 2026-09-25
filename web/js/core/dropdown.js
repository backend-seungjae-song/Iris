// 커스텀 드롭다운(네이티브 <select> 대체). 트리거 버튼 + 목록을 만들고 키보드·포커스·화면 경계를 다룬다.
//
// 소유 범위
//   .cc-dd 트리거·목록 DOM 과 그 열림 상태. 모양은 web/css/01c-components.css 의 .cc-dd-* 가 갖는다.
//
// 제공 API
//   createDropdown({ items, value, onChange, ariaLabel, className, showSub }) → { el, setValue, setItems, destroy }.
//   items: [{ value, label, sub? }]. label 은 화면에 보일 글자, sub 는 목록 항목 옆의 보조 글자(선택).
//   showSub 가 참이면 고른 항목의 sub 를 트리거에도 흐리게 곁들인다(기본 끔). 같은 값을 화면이 따로 보여 주는
//   곳(에뮬레이터 도구 막대의 runtime)에서 켜면 두 번 보이므로 기본은 끈다.
//
// 의존 대상
//   DOM 만 본다. 기능 모듈은 반환된 el 을 자기 화면 어딘가에 붙이기만 하면 된다.
//
// 배경
//   시안마다 .dd 를 따로 그렸고, 열고 닫는 동작(키보드·Esc·포커스 복귀·경계에서 위로 열기)은
//   화면마다 다시 짜야 했다. 모양은 CSS 한 벌로, 동작은 이 모듈 하나로 모은다.
//
// 유지 조건
//   Esc·바깥 클릭으로 닫히면 포커스는 항상 트리거로 돌아간다. 포커스가 메뉴 안에 남아 있으면
//   그다음 Tab 이 사라진 요소에서 시작해 어디로도 가지 않는다.
//   화면 아래에 목록을 다 펼칠 공간이 없으면 위로 연다(data-place="up"). 판정은 열 때 한 번,
//   트리거의 실제 위치로 한다.

let seq = 0;

export function createDropdown({ items, value, onChange, ariaLabel, className, showSub = false } = {}) {
  const id = `cc-dd-${++seq}`;
  const el = document.createElement("div");
  el.className = "cc-dd" + (className ? ` ${className}` : "");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cc-dd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("id", id);
  if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);

  const valueEl = document.createElement("span");
  valueEl.className = "cc-dd-value";
  trigger.appendChild(valueEl);

  // aria-label 이 있으면 트리거 글자는 이름에 들어가지 않으므로, 보조 글자는 설명(aria-describedby)으로 읽힌다.
  const subEl = document.createElement("span");
  subEl.className = "cc-dd-sub";
  subEl.id = `${id}-sub`;
  subEl.hidden = true;
  if (showSub) {
    trigger.appendChild(subEl);
    trigger.setAttribute("aria-describedby", subEl.id);
  }

  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("viewBox", "0 0 24 24");
  caret.innerHTML = '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  trigger.appendChild(caret);

  const menu = document.createElement("ul");
  menu.className = "cc-dd-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-labelledby", id);
  menu.hidden = true;

  el.appendChild(trigger);
  el.appendChild(menu);

  let list = Array.isArray(items) ? items : [];
  let current = value;
  let activeIndex = -1;

  function renderValue() {
    const found = list.find((it) => it.value === current);
    valueEl.textContent = found ? found.label : "";
    if (showSub) {
      const sub = found && found.sub ? String(found.sub) : "";
      subEl.textContent = sub;
      subEl.hidden = !sub;
    }
  }

  function renderMenu() {
    menu.innerHTML = "";
    list.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "cc-dd-item" + (i === activeIndex ? " active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", it.value === current ? "true" : "false");
      li.dataset.value = String(it.value);
      li.textContent = it.sub ? `${it.label} · ${it.sub}` : it.label;
      li.addEventListener("mouseenter", () => { activeIndex = i; highlight(); });
      li.addEventListener("click", () => { pick(i); });
      menu.appendChild(li);
    });
  }

  function highlight() {
    [...menu.children].forEach((li, i) => li.classList.toggle("active", i === activeIndex));
  }

  function place() {
    // 열기 직전 트리거 위치로 아래 여백을 본다. 스크롤 중 바뀔 수 있으니 열 때마다 다시 잰다.
    const r = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < 200 && r.top > spaceBelow;
    if (up) menu.dataset.place = "up"; else delete menu.dataset.place;
  }

  function open() {
    if (!menu.hidden) return;
    place();
    menu.hidden = false;
    el.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    activeIndex = Math.max(0, list.findIndex((it) => it.value === current));
    highlight();
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }

  function close({ refocus = true } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    el.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (refocus) trigger.focus();
  }

  function pick(i) {
    const it = list[i];
    if (!it) return;
    const changed = it.value !== current;
    current = it.value;
    renderValue();
    renderMenu();   // 다시 열 때 aria-selected 가 방금 고른 항목에 있어야 한다
    close();
    if (changed && typeof onChange === "function") onChange(current, it);
  }

  function onOutside(e) { if (!el.contains(e.target)) close({ refocus: false }); }

  // 처리한 키는 전파를 막는다. 막지 않으면 같은 keydown 이 트리거의 keydown 에 도달해 방금 닫은
  // 메뉴를 다시 열고, Esc 는 앱 전역 단축키(창·탭 닫기 등)까지 실행한다.
  function onKey(e) {
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { handled(); close(); return; }
    if (e.key === "ArrowDown") { handled(); activeIndex = Math.min(list.length - 1, activeIndex + 1); highlight(); return; }
    if (e.key === "ArrowUp") { handled(); activeIndex = Math.max(0, activeIndex - 1); highlight(); return; }
    if (e.key === "Enter" || e.key === " ") { handled(); pick(activeIndex); return; }
    if (e.key === "Tab") close({ refocus: false });
  }

  trigger.addEventListener("click", () => { if (menu.hidden) open(); else close(); });
  trigger.addEventListener("keydown", (e) => {
    if (menu.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); open();
    }
  });

  renderMenu();
  renderValue();

  return {
    el,
    setValue(v) { current = v; renderValue(); renderMenu(); },   // 닫혀 있어도 aria-selected 를 맞춰 둔다
    setItems(next) { list = Array.isArray(next) ? next : []; renderMenu(); renderValue(); },
    destroy() { close({ refocus: false }); el.remove(); },
  };
}

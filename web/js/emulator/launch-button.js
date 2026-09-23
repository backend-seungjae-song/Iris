// 채팅 패널 머리의 에뮬레이터 버튼. 누르면 가운데에 에뮬레이터 탭을 연다.
//
// 소유 범위
//   버튼 하나와 기기 고르기 목록.
//
// 제공 API
//   mountLaunchButton({ host, hasTab, onOpen }) → { dispose() }.
//
// 의존 대상
//   host(window.acHost.emulator) RPC(emulator.availability), devices-panel.js 의 표기 함수.
//   탭을 여는 일은 boot.js 가 onOpen 으로 받는다.
//
// 유지 조건
//   지금 스페이스에 에뮬레이터 탭이 없으면 기본 기기로 바로 연다(onOpen(null) → 설정의 기본 기기,
//   자동이면 켜진 기기 우선). 탭이 있으면 기기 목록을 띄우고 고른 기기로 그 탭을 바꾼다.
//
// 영향 범위
//   web/js/emulator/boot.js.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/launch-button.js
import { deviceLabel, runtimeLabel } from "./devices-panel.js";

const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>';

export function mountLaunchButton({ host, hasTab, onOpen }) {
  const head = document.querySelector(".right-head");
  if (!head) return { dispose() {} };
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sidebar-toggle emu-launch";
  btn.title = "모바일 에뮬레이터 켜기. 탭이 열려 있으면 기기를 고릅니다";
  btn.innerHTML = ICON;
  head.insertBefore(btn, head.querySelector(".dot") || null);

  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onOutside(e) { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); closeMenu(); btn.focus(); } }

  function item(text, sub, onClick, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emu-launch-item";
    b.disabled = !!disabled;
    const name = document.createElement("span");
    name.className = "emu-launch-name"; name.textContent = text;
    b.append(name);
    if (sub) { const r = document.createElement("span"); r.className = "emu-launch-runtime"; r.textContent = sub; b.append(r); }
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  async function openMenu() {
    menu = document.createElement("div");
    menu.className = "emu-launch-menu";
    menu.setAttribute("role", "menu");
    menu.append(item("기기 목록을 읽는 중…", "", null, true));
    const r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + "px";
    menu.style.left = Math.round(r.left) + "px";
    document.body.append(menu);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    const mine = menu;
    const res = await host.rpc("emulator.availability", {}).catch(() => null);
    if (menu !== mine) return;
    const devices = (res && res.ok && res.result && res.result.devices) || [];
    menu.replaceChildren();
    if (!devices.length) { menu.append(item("발견된 기기가 없습니다", "", null, true)); return; }
    for (const d of devices) {
      menu.append(item(deviceLabel(d), d.runtime ? runtimeLabel(d.runtime) : "",
        () => { closeMenu(); onOpen(d); }, d.isAvailable === false));
    }
    // 화면 오른쪽을 넘으면 버튼 오른쪽 끝에 맞춘다.
    const w = menu.getBoundingClientRect().width;
    if (r.left + w > window.innerWidth - 8) menu.style.left = Math.max(8, Math.round(r.right - w)) + "px";
    menu.querySelector(".emu-launch-item:not(:disabled)")?.focus();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }
    if (!hasTab()) { onOpen(null); return; }
    void openMenu();
  });

  return { dispose() { closeMenu(); btn.remove(); } };
}

// herdr 영역 조정판: 콘솔이 herdr 화면을 어디서 자를지 눈으로 맞춘다.
//
// 소유 범위
//   조정판 DOM 과 여는 버튼. 값 자체는 갖지 않는다.
//
// 제공 API
//   initCapability(). 그 밖의 것은 없다.
//
// 의존 대상
//   보정치는 앱 셸(panel/terminal.js)이 소유한다. 여기서 따로 저장하지 않고 그쪽 setter 만 부른다.
//   두 곳이 같은 값을 가지면 조정판을 꺼 둔 동안 위치가 되돌아간다.
//
// 유지 조건
//   끄면 조정판만 사라지고 맞춰 둔 값은 남는다. 이 파일이 없어도 터미널은 그대로 동작한다.
//
// 영향 범위
//   panel/terminal.js 의 crop 계산, web/css/31-crop-tuner.css.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/crop-tuner.js

import { getCropTune, setCropTune, resetCropTune } from "./terminal.js";

// 값은 둘이다. 가리기는 herdr 화면을 잘라 내는 것이고, 여백은 채팅 칸 안에서 그 화면이
// 얼마나 떨어지는지다. 섞어 두면 어느 쪽을 조정하는지 알기 어렵다.
const AXES = [
  { key: "left", label: "왼쪽", note: "herdr 자기 판을 가리는 폭", group: "가리기" },
  { key: "top", label: "위", note: "herdr 자기 탭 줄을 가리는 높이", group: "가리기" },
  { key: "right", label: "오른쪽", note: "오른쪽 끝을 채우는 폭", group: "가리기" },
  { key: "padTop", label: "위", note: "위쪽 여백: +는 비우고 −는 화면을 위로 넓힙니다", group: "여백" },
  { key: "padBottom", label: "아래", note: "아래쪽 여백: +는 비우고 −는 화면을 아래로 넓힙니다", group: "여백" },
];

let panel = null;

export function initCapability() {
  const head = document.querySelector(".right-head");
  if (!head) return {};
  const btn = document.createElement("button");
  btn.className = "sidebar-toggle crop-tune-open";
  btn.title = "herdr 자리 맞춤: 눌러서 1px 씩 옮깁니다";
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/>'
    + '<circle cx="7" cy="18" r="2"/></svg>';
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  head.insertBefore(btn, head.querySelector(".dot") || null);
  return {};
}

function toggle() {
  if (panel) { close(); return; }
  panel = document.createElement("div");
  panel.className = "crop-tune";
  panel.innerHTML = `<div class="ct-head"><span class="ct-title">herdr 자리 맞춤</span>
    <button class="ct-x" data-close title="닫기">✕</button></div>`
    + AXES.map((a, i) => (a.group !== AXES[i - 1]?.group ? `<div class="ct-g">${a.group}</div>` : "")
      + `<div class="ct-row" data-axis="${a.key}">
      <span class="ct-l" title="${a.note}">${a.label}</span>
      <button class="ct-b" data-step="-5">−5</button>
      <button class="ct-b" data-step="-1">−1</button>
      <span class="ct-v">0</span>
      <button class="ct-b" data-step="1">+1</button>
      <button class="ct-b" data-step="5">+5</button>
    </div>`).join("")
    + `<div class="ct-foot">
      <span class="ct-note">가리기의 위를 올리면 아래가 그만큼 빕니다</span>
      <button class="ct-b ct-reset" data-reset title="맞춰 둔 기준 자리로 되돌립니다">0으로</button>
    </div>`;
  document.body.appendChild(panel);
  panel.addEventListener("click", onClick);
  // 방향키로도 옮긴다. 1px 단위를 버튼만으로 맞추기는 어렵다.
  panel.addEventListener("keydown", onKey);
  panel.tabIndex = -1;
  panel.focus();
  paint();
}

function close() {
  panel?.remove();
  panel = null;
}

function onClick(e) {
  if (e.target.closest("[data-close]")) { close(); return; }
  if (e.target.closest("[data-reset]")) {
    resetCropTune();
    paint();
    return;
  }
  const b = e.target.closest("[data-step]");
  if (!b) return;
  const key = b.closest(".ct-row").dataset.axis;
  setCropTune({ [key]: getCropTune()[key] + Number(b.dataset.step) });
  paint();
}

function onKey(e) {
  const row = e.target.closest?.(".ct-row") || panel.querySelector(".ct-row");
  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!d || !row) return;
  e.preventDefault();
  setCropTune({ [row.dataset.axis]: getCropTune()[row.dataset.axis] + d * (e.shiftKey ? 5 : 1) });
  paint();
}

function paint() {
  if (!panel) return;
  const t = getCropTune();
  for (const row of panel.querySelectorAll(".ct-row")) {
    const v = t[row.dataset.axis];
    row.querySelector(".ct-v").textContent = v > 0 ? `+${v}` : String(v);
    row.classList.toggle("on", v !== 0);
  }
}

// 우측 터미널의 xterm 상태와 herdr 사이드바 crop·화면 행 읽기.
//
// 소유 범위
//   터미널 DOM, xterm·fit addon·PTY 시작·마우스 모드 상태, crop 설정과 감지 상태.
//
// 제공 API
//   initTerminal, 상태 접근자·setter, fit/crop 명령, herdr pane 시작 위치 판정과 현재 화면 행 캡처.
//
// 의존 대상
//   $·wsSend 는 main 이 소유해서 init 에서 받는다. 다른 모듈을 import 하지 않는다.
//
// 유지 조건
//   xterm 원시 값은 내보내지 않는다. 밖에서 바뀌는 상태는 setter 로만 갱신한다.
//   crop 은 herdr 상태를 바꾸지 않고 xterm 을 담은 안쪽 요소의 크기와 위치만 바꾼다.
//   복사 정리는 여기 없다. chatcopy/copy-text 가 소유한다. 이 파일이 정리 함수를
//   기능에서 등록받아 가지면, 기능을 꺼도 앱 셸에 빈 슬롯이 남는다.
//
// 영향 범위
//   터미널 렌더·크기·선택 복사와 main 의 PTY 수신/재연결 배선,
//   panel/xterm-wiring 과 chatcopy 의 xterm·crop 접근. getXterm 을 main 이 browser/{pick-host,pick,record}
//   초기화에 넘기므로 이 API를 바꾸면 그 세 모듈의 터미널 포커스 경로도 함께 간다.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/terminal.js
//   (경로 문자열이 아니라 import 절을 세어야 한다. 파일 이름만 세면 자기 헤더에 걸리고,
//    같은 폴더에서 './terminal.js' 로 받는 소비자를 놓친다.)

let $, wsSend;
let terminal = null, terminalInner = null;
let xterm = null, fitAddon = null, ptyStarted = false;
let appMouseOn = false;
let cropEnabled = true;
// herdr pane 영역 앞에 있는 칸 수(사이드바)와 줄 수(탭 줄). 화면 버퍼에서 읽는다.
// 사이드바 폭은 사용자가 끌면 바뀌고, 창이 좁으면 herdr 이 사이드바를 접고 위에 두 줄 머리를
// 그리므로 상수로 둘 수 없다. 읽지 못한 동안에는 마지막으로 읽은 값을 쓴다.
let origin = { cols: 0, rows: 0 };
let cropDetectTimer = null;
// addon-fit 이 스크롤바 몫으로 폭에서 빼는 값(overviewRuler 가 없을 때의 기본값).
const FIT_SCROLLBAR_PX = 14;
// 위아래 여백의 합의 최소값. 나머지가 이보다 작으면 한 줄을 빼서 여백으로 쓴다.
const MIN_VERTICAL_GAP_PX = 6;
// 오른쪽 끝의 빈 여백. 글자가 채팅 칸 테두리에 붙어 보이지 않게 한다.
const RIGHT_GAP_PX = 2;

// 사용자가 조정판으로 더하는 보정치. 기능(panel/crop-tuner)이 이 값을 쓰고, 기능을 꺼도
// 저장된 값은 그대로 적용된다. 끄는 것은 조정판이지 맞춰 놓은 값이 아니다.
const TUNE_KEY = "ac.crop.tune";
// 기준이 바뀌면 올린다. 이전 보정치를 새 기준에 그대로 적용하면 두 번 밀린다.
const TUNE_V = 3;
const TUNE_ZERO = { left: 0, top: 0, right: 0, padTop: 0, padBottom: 0 };
let tune = null;
export function getCropTune() {
  if (tune) return tune;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TUNE_KEY) || "null"); } catch {}
  const src = saved && typeof saved === "object" && saved.v === TUNE_V ? saved : {};
  tune = { ...TUNE_ZERO };
  for (const k of Object.keys(TUNE_ZERO)) tune[k] = Math.round(Number(src[k]) || 0);
  return tune;
}
export function setCropTune(patch) {
  tune = { ...getCropTune(), ...patch };
  for (const k of Object.keys(TUNE_ZERO)) tune[k] = Math.round(Number(tune[k]) || 0);
  try { localStorage.setItem(TUNE_KEY, JSON.stringify({ v: TUNE_V, ...tune })); } catch {}
  applyCropAndFit();
  return tune;
}
export function resetCropTune() { return setCropTune({ ...TUNE_ZERO }); }

export function initTerminal(deps) {
  ({ $, wsSend } = deps);
  terminal = $("#terminal");
  terminalInner = $("#terminal-inner");
  cropEnabled = localStorage.getItem("ac.crop") !== "0";
  watchPixelRatio();
}

export function getTerminal() { return terminal; }
export function getTerminalInner() { return terminalInner; }
export function getXterm() { return xterm; }
export function setXterm(value) { xterm = value; }
export function getFitAddon() { return fitAddon; }
export function setFitAddon(value) { fitAddon = value; }
export function getPtyStarted() { return ptyStarted; }
export function setPtyStarted(value) { ptyStarted = value; }
export function getAppMouseOn() { return appMouseOn; }
export function setAppMouseOn(value) { appMouseOn = value; }
export function getCropEnabled() { return cropEnabled; }
export function setCropEnabled(value) { cropEnabled = value; }
export function fitTerminal() { try { fitAddon?.fit(); } catch {} }

const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
export function xtermTheme() {
  // 커서=팔레트(sky-pop, 밝고 잘 보임), 배경·전경=soft ink/paper, 선택=커서와 같은 팔레트 틴트.
  return isDark()
    ? { background: "#0A1620", foreground: "#E7F4FB", cursor: "#85E8F6", selectionBackground: "rgba(133,232,246,.26)" }
    : { background: "#EAF3FA", foreground: "#0A1620", cursor: "#00AFF0", selectionBackground: "rgba(0,175,240,.20)" };
}

// xterm의 정확한 셀 크기(css px). 픽셀 반올림 오차를 없애 그리드에 정확히 정렬.
function exactCellWidth() {
  try { return xterm._core._renderService.dimensions.css.cell.width || 0; } catch { return 0; }
}
function exactCellHeight() {
  try { return xterm._core._renderService.dimensions.css.cell.height || 0; } catch { return 0; }
}

const BARS = /[│▕┃▏▐⎸⎹|]/;
const isBar = (line, x) => BARS.test(line?.getCell(x)?.getChars() || "");

// 사이드바 경계선은 맨 윗줄(탭 줄)부터 아래로 이어진다. pane 테두리는 탭 줄을 지나지
// 않으므로 맨 윗줄로 가려낸다. herdr 알림 창이 떠 있으면 일부 줄이 가려져 전부를 요구하지 않는다.
function findDivider(buf, start) {
  const rows = xterm.rows, top = buf.getLine(start);
  for (let x = 0; x < xterm.cols - 1; x++) {
    if (!isBar(top, x)) continue;
    let n = 0;
    for (let y = 0; y < rows; y++) if (isBar(buf.getLine(start + y), x)) n++;
    if (n >= rows * 0.6) return x;
  }
  return -1;
}

// 사이드바를 접은 herdr 은 맨 위 두 줄에 머리를 그리고, 두 줄의 같은 열에 구분선을 둔다.
function collapsedHeader(buf, start) {
  const a = buf.getLine(start), b = buf.getLine(start + 1), c = buf.getLine(start + 2);
  for (let x = 1; x < xterm.cols; x++) if (isBar(a, x) && isBar(b, x) && !isBar(c, x)) return true;
  return false;
}

// 탭 줄 아래에 글자 없이 괘선만 있는 줄이 붙으면 그 줄도 탭 줄에 속한다.
// 빈 줄은 화면 내용이므로 남기고 멈춘다.
function tabBarRows(buf, start, skip) {
  let rows = 1;
  for (let y = 1; y < 3 && y < xterm.rows; y++) {
    const text = buf.getLine(start + y)?.translateToString(true, skip) || "";
    if (/[─━═╌╍▁▔▬_]/.test(text) && !/[^\s─━═╌╍▁▔▬_]/.test(text)) { rows++; continue; }
    break;
  }
  return rows;
}

// 지금 화면에서 pane 영역이 시작하는 칸과 줄. herdr 화면으로 읽히지 않으면 null 이다.
export function detectOrigin() {
  try {
    const buf = xterm.buffer.active, start = buf.baseY;
    const d = findDivider(buf, start);
    if (d >= 0) return { cols: d + 1, rows: tabBarRows(buf, start, d + 1) };
    if (collapsedHeader(buf, start)) return { cols: 0, rows: 2 };
  } catch {}
  return null;
}

// pane이 divider 다음에 두는 왼쪽 여백의 폭. 선택 영역이 아니라 화면 전체에서 측정한다.
function detectLeftGutter(skip) {
  try {
    const buf = xterm.buffer.active, start = buf.baseY;
    const MAX = 6;
    let gutter = 0;
    for (let x = skip; x < skip + MAX && x < xterm.cols; x++) {
      let content = 0, blank = 0;
      for (let y = 0; y < xterm.rows; y++) {
        const line = buf.getLine(start + y); if (!line) continue;
        if (!line.translateToString(true, skip).trim()) continue;
        content++;
        const ch = line.getCell(x)?.getChars();
        if (!ch || ch === " ") blank++;
      }
      if (content < 3 || blank < content * 0.9) break;
      gutter++;
    }
    return gutter;
  } catch { return 0; }
}

export function sidebarCols() {
  return (xterm && detectOrigin()?.cols) ?? origin.cols;
}

// 칸 수와 위치를 셀 크기로 계산한다. herdr pane 의 첫 칸은 채팅 칸 왼쪽 끝에 두고 오른쪽 끝까지
// 채운다(마지막 칸은 일부 잘릴 수 있다). 세로는 온전한 줄만 보이고, 줄 높이로 나누어떨어지지 않는
// 나머지는 위아래 여백으로 반씩 나눈다. 반쯤 잘린 줄은 herdr 화면이 덜 가려진 것처럼 보이고,
// 마지막 줄이 아래 끝에 붙으면 잘린 것처럼 보인다.
// 안쪽 요소는 흐름 밖(position:absolute)에 두므로 그 크기가 .terminal 크기를 바꾸지 않는다.
export function applyCropAndFit() {
  if (!xterm || !fitAddon) return;
  fittedCell = cellKey();
  // 보이는 화면이 채팅 칸 안에서 위아래로 얼마나 떨어질지 정한다. 자르는 것과는 다른 축이다.
  // 안쪽 여백으로 두면 0 아래로 내려갈 수 없어 화면을 키울 수 없으므로, 바깥 여백으로 두어 음수도 허용한다.
  const tn = getCropTune();
  terminal.style.marginTop = tn.padTop + "px";
  terminal.style.marginBottom = tn.padBottom + "px";
  const cw = exactCellWidth(), ch = exactCellHeight();
  if (!(cw > 0 && ch > 0)) {
    Object.assign(terminalInner.style, { left: "0", top: "0", width: "100%", height: "100%", clipPath: "" });
    try { fitAddon.fit(); } catch {}
    return;
  }
  const o = cropEnabled ? origin : { cols: 0, rows: 0 };
  // 소수점까지 잰다. clientWidth·clientHeight 는 정수로 반올림해 0.5px 차이로 한 칸이 달라진다.
  const box = terminal.getBoundingClientRect();
  // 조정판 값: left 는 pane 을 왼쪽으로, top 은 화면 전체를 위로 더 미는 px 이고 right 는 오른쪽에 더 들일 폭이다.
  const cols = o.cols + Math.max(1, Math.ceil((box.width + tn.left + tn.right) / cw - 1e-3));
  const usableH = box.height - tn.top;
  const paneRows = Math.max(1, Math.floor((usableH - MIN_VERTICAL_GAP_PX) / ch + 1e-3));
  const rows = o.rows + paneRows;
  const bottomGap = Math.max(0, usableH - paneRows * ch) / 2;
  // addon-fit 은 정수 px 로 읽고 내림하므로 반 칸을 더해 원하는 칸 수가 나오게 한다.
  const innerW = Math.ceil(cols * cw + FIT_SCROLLBAR_PX + cw / 2);
  terminalInner.style.width = innerW + "px";
  terminalInner.style.height = Math.ceil(rows * ch + ch / 2) + "px";
  terminalInner.style.left = -(o.cols * cw + tn.left).toFixed(3) + "px";
  terminalInner.style.top = (usableH - bottomGap - rows * ch).toFixed(3) + "px";
  try { fitAddon.fit(); } catch {}
  // 위쪽 여백 자리에는 탭 줄이, 왼쪽에는 사이드바가 걸친다. pane 첫 줄이 실제로 그려진 위치에서 잘라
  // 조금도 보이지 않게 한다. 계산한 위치(o.rows * ch)는 소수점이라, 화면 픽셀에 맞춰 그려진 줄과
  // 어긋나 탭 줄 밑 1px 이 남거나 첫 줄 글자 위쪽이 잘린다.
  let clipTop = o.rows * ch;
  const paneRow = o.rows > 0 && terminalInner.querySelectorAll(".xterm-rows > div")[o.rows];
  if (paneRow) clipTop = paneRow.getBoundingClientRect().top - terminalInner.getBoundingClientRect().top;
  // 오른쪽은 채팅 칸 끝에서 RIGHT_GAP_PX 앞에서 자른다. 칸 수로 맞추면 여백이 0~1칸 사이로 달라진다.
  const clipRight = Math.max(0, innerW - (o.cols * cw + tn.left + box.width - RIGHT_GAP_PX));
  terminalInner.style.clipPath = `inset(${clipTop.toFixed(3)}px ${clipRight.toFixed(3)}px 0 ${(o.cols * cw).toFixed(3)}px)`;
}

// 창을 배율이 다른 모니터로 옮기면 채팅 칸 크기는 그대로여도 셀 크기가 바뀐다. 칸 크기만 보고
// 다시 계산하면 이전 셀 크기로 맞춘 위치가 남으므로, 셀 크기와 배율도 함께 확인한다.
let fittedCell = "";
const cellKey = () => `${exactCellWidth()}x${exactCellHeight()}@${devicePixelRatio}`;

function refit() {
  applyCropAndFit();
  fittedCell = cellKey();
  wsSend({ type: "pty.resize", cols: xterm.cols, rows: xterm.rows });
}

function refreshCropDetection() {
  if (!xterm) return;
  const o = cropEnabled ? detectOrigin() : null;
  const moved = o && (o.cols !== origin.cols || o.rows !== origin.rows);
  if (moved) origin = o;
  if (moved || cellKey() !== fittedCell) refit();
}

// 배율이 바뀌면 xterm 이 셀 크기를 다시 재고 화면을 다시 그린다. 그 뒤에 맞춘다.
function watchPixelRatio() {
  const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  mq.addEventListener("change", () => { scheduleCropDetect(); watchPixelRatio(); }, { once: true });
}

export function scheduleCropDetect() {
  clearTimeout(cropDetectTimer);
  cropDetectTimer = setTimeout(refreshCropDetection, 150);
}

export function selSkip() {
  const bar = cropEnabled ? sidebarCols() : 0;
  return bar + detectLeftGutter(bar);
}

export function screenRows(skip) {
  const buf = xterm.buffer.active, base = buf.baseY, out = [];
  for (let y = 0; y < xterm.rows; y++) {
    const line = buf.getLine(base + y);
    out.push(line ? window.IrisScrollbackCopy.terminalContentRow(
      line.translateToString(true, skip, xterm.cols)) : "");
  }
  return out;
}

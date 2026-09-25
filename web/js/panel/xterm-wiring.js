// 우측 터미널의 xterm 을 만들고 입출력을 연결한다.
//
// 소유 범위
//   xterm 생성·옵션·테마, PTY 시작과 크기 전송, herdr 마우스 모드 억제와 휠·클릭 리포트,
//   터미널 링크 제공자와 수식키 링크 모드, 한글 IME 전송 교정, 키 가로채기.
//
// 제공 API
//   initXtermWiring, initXterm, startPty, sendPtyResize,
//   링크 판정의 순수 함수(terminalBarePathToken · terminalLinkSpans · linkProbePoints · linkProbeTarget).
//
// 의존 대상
//   xterm·crop 상태와 터미널 DOM 은 panel/terminal 에서 import 한다.
//   터미널 링크 동작은 center/file-routing 에서 import 한다.
//   blog·wsSend·showToast 와 현재 WebSocket·pane 접근자는 main 이 소유해서 init 에서 받는다.
//
// 유지 조건
//   복붙 기능은 여기 없다. 화면 밖 드래그 복사·복사 정리·자동 복사·파일 드롭 경로 삽입은
//   chatcopy 기능이 소유하고, 이 파일은 훅 이름만 부른다. 로드되지 않았으면 아무 일도 하지 않는다.
//   그 기능을 꺼도 놓은 파일로 창이 넘어가는 것만은 여기서 막는다.
//   document 리스너를 포함한 연결 순서는 initXterm 안의 기존 순서를 유지한다.
//   ⌘ 을 눌렀을 때 흘리는 가짜 mousemove 는 xterm 이 듣는 .xterm-screen 으로 쏜다. 컨테이너에
// 보내면 자손에게 전달되지 않아 동작하지 않는다(확인).
//
// 영향 범위
//   main 의 PTY 수신·재연결·초기 부팅, center/file-routing 의 터미널 링크 API,
//   chatcopy 가 채우는 훅 이름(chatcopy.wheel·dragStart·dragMove·dragEnd·selectionChanged·
//   dragHint·dropFiles·captureAfterWrite).
//   현재 목록 확인: node bin/importers.mjs web/js/panel/xterm-wiring.js
import {
  openTerminalLink, openTerminalPath, openTerminalTarget, revealTerminalPath, wantsReveal,
} from "../center/file-routing.js";
import {
  applyCropAndFit, getAppMouseOn, getCropEnabled, getFitAddon, getPtyStarted, getTerminal,
  getTerminalInner, getXterm, setAppMouseOn, setFitAddon, setPtyStarted, setXterm, sidebarCols,
  xtermTheme,
} from "./terminal.js";
import { callHook } from "../core/hooks.js";

let blog, wsSend, showToast, getWs, getCurTarget;

export function initXtermWiring(deps) {
  ({ blog, wsSend, showToast, getWs, getCurTarget } = deps);
}

function mouseReportCell(e) {
  const xterm = getXterm(), terminalInner = getTerminalInner();
  const rows = xterm.rows || 24, cols = xterm.cols || 80;
  const screen = xterm._core?.screenElement || terminalInner.querySelector?.(".xterm-screen") || terminalInner;
  try {
    // xterm 선택 좌표는 글자 절반을 기준으로 앞/뒤 경계에 붙고, mouse report는 포인터 아래 셀을
    // 가리킨다. 휠·클릭에 선택 경계를 쓰면 셀 오른쪽 절반에서 한 칸 옆으로 전송된다.
    const point = xterm._core._mouseService.getMouseReportCoords(e, screen);
    if (point && Number.isInteger(point.col) && Number.isInteger(point.row)) {
      return {
        row: Math.max(0, Math.min(rows - 1, point.row)),
        col: Math.max(0, Math.min(cols - 1, point.col)),
      };
    }
  } catch {}
  const rect = screen.getBoundingClientRect();
  const dims = xterm._core?._renderService?.dimensions?.css?.cell || {};
  const cellW = Number(dims.width) || rect.width / cols;
  const cellH = Number(dims.height) || rect.height / rows;
  return {
    row: Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rect.top) / cellH))),
    col: Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rect.left) / cellW))),
  };
}
export function sendPtyResize() {
  const xterm = getXterm();
  if (!xterm || !getFitAddon()) return;
  applyCropAndFit();
  wsSend({ type: "pty.resize", cols: xterm.cols, rows: xterm.rows });
}
export function startPty() {
  const xterm = getXterm(), ws = getWs();
  if (getPtyStarted() || !xterm) return;
  if (!ws || ws.readyState !== 1) return; // ws 미개통: onopen에서 재호출된다
  setPtyStarted(true);
  applyCropAndFit();
  wsSend({ type: "pty.start", cols: xterm.cols, rows: xterm.rows });
}
// 터미널 산문에 `/path/file.xlsx를 열어…`처럼 경로 바로 뒤에 조사가 붙는다. Unicode 경로 토큰은
// 그 조사까지 합쳐 잡으므로, ASCII 확장자 뒤의 문법 조사만 링크 밖으로 둔다. 파일명 안의 한글과
// 확장자 없는 한글 파일명은 건드리지 않는다.
// 채팅 링크는 수식키(⌘·⌃)를 누르고 있는 동안에만 성립한다.
//
// activate 에서 막지 않고 제공자에서 링크를 내주지 않는 방식이다. activate 만 막으면 밑줄은
// 그대로 뜨고(누를 수 있어 보이고) 클릭은 xterm 이 소비해, 눌러도 동작하지 않으면서 드래그 선택도
// 되지 않는다. 링크가 없으면 그 영역은 일반 텍스트라 선택이 정상 동작한다.
//
// 맨 경로에서도 수식키를 요구한다.
// 문제였던 것은 수식키 요구가 아니라 밑줄은 떠 있는데 눌러도 동작하지 않는 상태였다.
// 지금은 누르지 않으면 밑줄도 뜨지 않는다. 이 조건을 되돌리지 않는다.
//
// ⌘·⌃ 둘 다 받는다. 두 키를 맞바꿔 쓰는 키보드 배치가 있고 저장소 전체가 그 규약을 쓴다.
let linkKeyHeld = false;
let lastPointer = null;
export function linkModeHeld() { return linkKeyHeld; }
export function linkModeFromEvent(e) { return !!(e && (e.metaKey || e.ctrlKey)); }

// 다시 묻게 하려면 셀이 달라져야 한다. xterm 은 마지막으로 본 셀과 같으면 제공자를 아예 안
// 부른다(lib/xterm.js 의 _handleMouseMove: `_lastBufferCell && t.x===… && t.y===… || _handleHover`).
// 그래서 마지막 포인터 위치로 보내면 항상 같은 셀이라 무효가 된다. 키를 눌러도
// 밑줄이 뜨지 않고, 마우스를 실제로 움직여 다른 셀로 가야 활성화된다(확인
// 결과). 다른 셀을 한 번 찍고 제자리로 돌아온다.
export const LINK_PROBE_JUMP = 40;   // 한 셀(행 높이·열 너비)보다 확실히 크다

export function linkProbePoints(pointer, rect) {
  if (!pointer) return [];
  const here = { x: pointer.x, y: pointer.y };
  if (!rect || !(rect.height > 0) || !(rect.width > 0)) {
    return [{ x: here.x, y: here.y + LINK_PROBE_JUMP }, here];
  }
  // 안쪽으로 뛴다. 밖으로 나가면 브라우저가 다른 요소에 이벤트를 주거나 좌표가 잘려 같은 셀로
  // 되돌아온다. 그러면 다시 동작하지 않는다.
  let probe = { x: here.x, y: here.y + LINK_PROBE_JUMP };
  if (probe.y > rect.bottom - 1) probe = { x: here.x, y: here.y - LINK_PROBE_JUMP };
  if (probe.y < rect.top) {
    // 위아래로 이동할 공간이 없다(터미널이 매우 낮음). 옆으로 이동한다.
    probe = { x: here.x + LINK_PROBE_JUMP, y: here.y };
    if (probe.x > rect.right - 1) probe = { x: here.x - LINK_PROBE_JUMP, y: here.y };
    if (probe.x < rect.left) return [here];   // 어느 쪽으로도 이동할 수 없으므로 중단한다
  }
  return [probe, here];
}

// 보내는 대상은 컨테이너가 아니라 xterm 이 실제로 듣는 요소다. xterm 은 .xterm-screen 에 mousemove
// 를 걸고, 그것은 컨테이너의 자손이다. 이벤트는 위로만 전파되므로 컨테이너에 보낸 것은 자손에게
// 전달되지 않는다.
// 헤드리스 확인 결과: 컨테이너에 보내면 제공자 호출 0, .xterm-screen 에 보내면 1·2 다.
export function linkProbeTarget(inner) {
  if (!inner) return null;
  try { return inner.querySelector(".xterm-screen") || inner; } catch { return inner; }
}

function setLinkMode(on) {
  if (linkKeyHeld === on) return;
  linkKeyHeld = on;
  if (!lastPointer) return;
  const inner = getTerminalInner();
  const el = linkProbeTarget(inner);
  if (!el) return;
  let rect = null;
  try { rect = el.getBoundingClientRect(); } catch {}
  const points = linkProbePoints(lastPointer, rect);
  if (points.length < 2) return;   // 제자리 한 번은 같은 셀이라 보내지 않는다
  for (const point of points) {
    try {
      el.dispatchEvent(new MouseEvent("mousemove", {
        clientX: point.x, clientY: point.y, bubbles: true,
        metaKey: on, ctrlKey: on,
      }));
    } catch {}
  }
}

export function wireLinkMode(el) {
  // 캡처 단계다. xterm 자신의 mousemove 가 제공자를 부르기 *전에* 상태를 맞춰야 한다.
  // 버블로 받으면 한 박자 늦은 상태로 판정한다.
  el.addEventListener("mousemove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    linkKeyHeld = linkModeFromEvent(e);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Meta" || e.key === "Control") setLinkMode(true);
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Meta" || e.key === "Control") setLinkMode(false);
  });
  // 창을 떠나면 keyup 이 오지 않는다. 눌린 상태로 남으면 누르지 않아도 링크가 열린다.
  window.addEventListener("blur", () => setLinkMode(false));
}

// 앱이 터미널에 넣는 글의 표식. 이 글 뒤에는 사람이 이어서 지시를 타이핑하므로, 닫는 표식이
// 없으면 앱이 준 사실과 사람이 한 말이 한 덩어리로 붙는다. 두 표식은 반드시 짝으로 나가야 하니
// 한 함수가 함께 붙인다. 기능마다 따로 적으면 한쪽만 남을 수 있다. 터미널에 무엇이 들어가는지는
// 앱 셸의 책임이라 이 파일이 소유하고, 요소 지목·화면 스케치가 이것을 부른다.
export function noticeBlock(title, lines) {
  return ["⟦Iris⟧ " + title, ...lines.filter(Boolean), "⟦/Iris⟧"].join("\n");
}
export function terminalBarePathToken(raw) {
  return String(raw || "").replace(/(\.[A-Za-z0-9]{1,10})(?:으로|에서|까지|부터|에게|처럼|보다|이나|라도|을|를|은|는|이|가|와|과|로|에|의|도|만)$/u, "$1");
}
// 링크 판정은 여기 하나에 모은다. xterm 버퍼가 아니라 "셀 공급자"만 보므로 화면 없이 부를 수
// 있고, 검사가 소스 형태가 아니라 실제 이 코드를 실행한다.
//
// cellsAt(ry) 는 그 행의 다듬지 않은 셀 [{ch, x, endX, y}] 또는 없으면 null 을 준다.
// 돌려주는 것은 이 행(y)과 겹치는 링크들 [{ range, text, kind }] 이고 kind 는 md·url·path 다.
//
// 이어진 줄 판정이 이 함수의 핵심이다. herdr TUI 는 긴 경로를 다음 행으로 넘길 때 각 행에
// 사이드바를 다시 그린다(xterm 의 소프트 랩이 아니다). 그래서 "이어졌다"를 우리가 판정해야
// 하는데, **줄이 오른쪽 끝까지 찼을 때만** 이어진 것이다. 이 조건이 없으면 목록으로
// 나열된 경로가 구분자 없이 한 덩어리로 붙는다(확인 결과: `- /Users/x/a.js` 세 줄이
// `/Users/x/a.js-` · `/Users/x/b.js-` · `/Users/x/c.js` 가 되어 마지막 줄만 열렸다).
export function terminalLinkSpans(cellsAt, y, opts = {}) {
  const EDGE_SLACK = opts.edgeSlack == null ? 3 : opts.edgeSlack;
  const softWrapped = opts.softWrapped || (() => false);
  const pathCh = /[\p{L}\p{N}\p{M}_./@+%~-]/u;
  const trimEnd = (c) => { let e = c.length; while (e > 0 && /[\s│▕┃▏▐⎸⎹|]/.test(c[e - 1].ch)) e--; return e; };
  const cellsOf = (ry) => { const c = cellsAt(ry); return c == null ? null : c.slice(0, trimEnd(c)); };
  // 테두리·패딩 몇 칸은 허용한다. herdr 는 content 오른쪽에 테두리와 패딩을 그린다.
  const reachesEdge = (ry) => {
    const c = cellsAt(ry); if (!c || !c.length) return false;
    const e = trimEnd(c); if (!e) return false;
    return c[c.length - 1].endX - c[e - 1].endX <= EDGE_SLACK;
  };
  // 토큰 한가운데서 끊긴 줄. 파일 이름은 이런 글자로 끝나지 않으므로, 이렇게 끝났다면 다음 줄이
  // 그 토큰의 나머지다. 오른쪽 끝을 채웠는지만 보면 이 경우를 놓친다. 코덱스 TUI 는 줄을 끝까지
  // 채우지 않고 토큰을 하이픈에서 자른다(확인 결과: 폭 110칸 화면에서 그 줄은 104칸에서
  // 끝나고 `information-` 로 잘렸다. 다음 줄이 `preservation-verification.md)` 였다).
  const JOINER = /[-_/.+%@]/;
  // 다음 줄이 새 항목이면 이어진 줄이 아니다. `- `·`* `·`1. ` 같은 표시가 그 증거다.
  // 이 문이 없으면 디렉터리 목록(`- /a/b/` 처럼 `/` 로 끝나는 줄)이 위 규칙에 걸려 한 덩이가 된다.
  const newItemAt = (n, i) => {
    const ch = n[i].ch;
    const after = i + 1 < n.length ? n[i + 1].ch : "";
    if ((ch === "-" || ch === "*" || ch === "•" || ch === "·") && after === " ") return true;
    let k = i; while (k < n.length && /[0-9]/.test(n[k].ch)) k++;
    return k > i && k + 1 < n.length && /[.)]/.test(n[k].ch) && n[k + 1].ch === " ";
  };
  const continues = (ry) => {
    const c = cellsOf(ry); if (!c || !c.length || !pathCh.test(c[c.length - 1].ch)) return false;
    const n = cellsOf(ry + 1); if (!n || !n.length) return false;
    let i = 0; while (i < n.length && n[i].ch === " ") i++;
    if (i >= n.length || !pathCh.test(n[i].ch)) return false;
    if (newItemAt(n, i)) return false;
    // 안 찬 줄이라도 토큰 한가운데서 끊겼으면 이어진 줄이다.
    return softWrapped(ry) || reachesEdge(ry) || JOINER.test(c[c.length - 1].ch);
  };
  let startY = y; while (startY > 1 && continues(startY - 1)) startY--;
  let text = "", first = true; const map = [];
  for (let ry = startY; ; ry++) {
    const c = cellsOf(ry); if (c === null) break;
    let s = 0; if (!first) { while (s < c.length && c[s].ch === " ") s++; } // 연속 행 선행 인덴트 제거
    for (let k = s; k < c.length; k++) { text += c[k].ch; map.push(c[k]); }
    first = false;
    if (!continues(ry)) break;
  }
  const links = [], taken = [];
  // 겹치면 먼저 잡은 쪽(더 구체적인 md 링크)이 우선한다. 그렇지 않으면 md 링크 안의 경로가 따로 잡혀
  // 라벨·괄호가 링크 밖으로 떨어져 나간다.
  const overlaps = (st, en) => taken.some(([ts, te]) => st < te && ts < en);
  const add = (start, len, label, kind) => {
    if (len < 3) return;
    const end = start + len;
    if (overlaps(start, end)) return;
    const a = map[start], b = map[end - 1]; if (!a || !b) return;
    if (y < a.y || y > b.y) return; // 이 행과 교차하는 링크만(멀티행 range 그대로 반환)
    taken.push([start, end]);
    links.push({ range: { start: { x: a.x, y: a.y }, end: { x: b.endX, y: b.y } }, text: label, kind });
  };
  // 1) 마크다운 링크 `[라벨](대상)`. 라벨부터 닫는 괄호까지 통째로 누를 수 있어야 한다.
  const MD = /\[[^\]\n]{1,200}\]\((file:\/\/[^)\s]+|https?:\/\/[^)\s]+|~?\/[^)\s]+)\)/g;
  let mm;
  while ((mm = MD.exec(text))) add(mm.index, mm[0].length, mm[1], "md");
  // 2) 맨 URL
  const URLRE = /(?:https?|file):\/\/[^\s<>"\'`\])]+/g;
  while ((mm = URLRE.exec(text))) add(mm.index, mm[0].length, mm[0], "url");
  // 3) 맨 경로. 오인 방지는 수식키가 아니라 대상 자체로 건다(루트가 명시됐거나 작업 폴더 안으로
  //    풀리는 토큰만 openTerminalPath 의 경계 검사를 통과해 실제로 열린다).
  const PATHRE = /(?:~|\.{0,2})?(?:\/[\p{L}\p{N}\p{M}_.@+%-]+)+(?::\d+)?|(?:[\p{L}\p{N}\p{M}_.@+%-]+\/)+[\p{L}\p{N}\p{M}_.@+%-]+(?::\d+)?/gu;
  while ((mm = PATHRE.exec(text))) {
    const raw = terminalBarePathToken(mm[0]); if (!raw.includes("/")) continue;
    add(mm.index, raw.length, raw, "path");
  }
  return links;
}

// 글자 12px, 행 높이는 그 1.6배다. xterm 의 lineHeight 는 글꼴이 잰 글자 높이에 곱하는 배수라
// 글꼴마다 값이 달라지므로, 연 뒤에 잰 높이로 나눠 행 높이를 px 로 맞춘다. 1 미만은 xterm 이 거부한다.
const TERM_FONT_PX = 12, TERM_LINE_PX = TERM_FONT_PX * 1.6;
function fitLineHeight(xterm) {
  try {
    const h = xterm._core._charSizeService.height;
    if (h > 0) xterm.options.lineHeight = Math.max(1, TERM_LINE_PX / h);
  } catch {}
}

export function initXterm() {
  let xterm = getXterm(), fitAddon = getFitAddon();
  if (xterm) return;
  xterm = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(), fontSize: TERM_FONT_PX, lineHeight: 1,
    cursorBlink: true, cursorStyle: "block", scrollback: 5000, convertEol: false, theme: xtermTheme(), allowProposedApi: true,
    // 채팅 속 링크는 확인 팝업 없이 이 스페이스의 브라우저 탭·뷰어에서 연다(xterm 기본 confirm+window.open 대체).
    // allowNonHttpProtocols는 필수다. 없으면 xterm이 file: OSC 8 링크를 링크로 내주지 않아
    // 클릭이 성립하지 않는다(확인). 이 코드가 주는 파일 링크는 전부 file: 이다.
    linkHandler: {
      allowNonHttpProtocols: true,
      // OSC 8 링크는 xterm 이 직접 만들어 제공자를 거치지 않으므로, 여기서 같은 조건을 적용한다.
      activate: (ev, uri) => { if (!linkModeFromEvent(ev)) return; openTerminalLink(uri, ev); },
    },
    // herdr가 마우스 트래킹을 켠 뷰에선 그냥 드래그가 herdr로 가서 텍스트 선택이 안 된다. 이 옵션을 켜면
    // ⌥(Option)+드래그가 herdr 마우스를 우회해 "선형" 선택을 강제한다(xterm: altKey && 이 옵션이면
    // rectangular가 아니라 forceSelection). herdr 마우스 기능은 그대로 유지. → ⌥드래그로 복사.
    macOptionClickForcesSelection: true,
  });
  setXterm(xterm);
  fitAddon = new FitAddon.FitAddon();
  setFitAddon(fitAddon);
  xterm.loadAddon(fitAddon);
  const terminalInner = getTerminalInner(), terminal = getTerminal();
  xterm.open(terminalInner);
  fitLineHeight(xterm);
  wireLinkMode(terminalInner);
  try { fitAddon.fit(); } catch {}
  // 파일 경로 감지 → ⌘/Ctrl+클릭으로 가운데 뷰어에 연다(VSCode식). 상대경로는 현재 에이전트 cwd 기준.
  // herdr TUI 대응: herdr는 긴 경로를 다음 행으로 넘길 때 각 행에 사이드바를 다시 그린다(xterm의
  // isWrapped 소프트랩이 아님). 그래서 (1)사이드바 열(skip)을 제외한 content pane만 읽고 (2)행이
  // 오른쪽 끝까지 꽉 차 있으면 다음 행으로 이어진 것으로 보고 content를 이어붙여 경로 잘림을 없앤다.
  try {
    xterm.registerLinkProvider({
      provideLinks(y, cb) {
        // 수식키를 누르지 않았으면 이 위치에 링크는 없다. 밑줄도 없고 클릭도 글자 선택이다.
        if (!linkModeHeld()) { cb(undefined); return; }
        const buf = xterm.buffer.active;
        const cols = xterm.cols;
        // 사이드바(skip) 제외. herdr 는 content 좌측=사이드바, 우측=박스 테두리+패딩 구조다(확인).
        const skip = getCropEnabled() ? sidebarCols() : 0;
        // 문자열 인덱스는 화면 열이 아니다. 한글 같은 전각 문자는 한 글자가 두 셀을 차지하므로
        // 실제 버퍼 셀을 걸어야 링크 밑줄·클릭 범위가 글자 끝까지 맞는다.
        const cellsAt = (ry) => {
          const ln = buf.getLine(ry - 1); if (!ln) return null;
          const c = [];
          for (let col = skip; col < cols; col++) {
            const cell = ln.getCell(col); if (!cell) break;
            const width = cell.getWidth(); if (width === 0) continue; // 전각 문자의 뒤쪽 빈 셀
            const chars = cell.getChars() || " ";
            const pos = { x: col + 1, endX: col + Math.max(1, width), y: ry };
            for (let i = 0; i < chars.length; i++) c.push({ ch: chars[i], ...pos });
          }
          return c;
        };
        const softWrapped = (ry) => { const n = buf.getLine(ry); return !!(n && n.isWrapped); };
        const spans = terminalLinkSpans(cellsAt, y, { softWrapped });
        const links = spans.map((sp) => ({
          range: sp.range,
          text: sp.text,
          activate: (ev) => {
            // 여기서 던진 예외는 xterm이 삼켜, 사용자에게는 아무 반응 없음으로만 보인다(진단 불가).
            try {
              if (sp.kind !== "path") { openTerminalTarget(sp.text, ev); return; }
              if (wantsReveal(ev)) { revealTerminalPath(sp.text); return; }   // ⌘⇧ = Finder에서 보기
              openTerminalPath(sp.text);
            } catch (err) { showToast("여는 중 오류: " + (err && err.message || err)); }
          },
        }));
        cb(links.length ? links : undefined);
      },
    });
  } catch {}
  // herdr가 켜는 마우스 트래킹(DECSET 1000~1006/1015/1016)을 xterm 쪽에서만 억제한다. 목적은
  // "그냥 드래그 = 로컬 텍스트 선택"을 유지하는 것이고, 복붙 동작이 그 위에 있다.
  // 억제는 xterm의 자동 전달만 끄는 것이고, herdr가 원하는 이벤트는 아래에서 우리가 직접 만들어 보낸다:
  // 휠은 스크롤 리포트로, 움직이지 않은 클릭은 press+release 리포트로. 그래야 herdr가 주는 기능
  // (탭 클릭 이동, "1 new message (click) ↓" 배너, 복사 토스트 등)이 그대로 동작한다.
  // 원칙: herdr를 그대로 표시한다. 의도적으로 바꾸는 것(드래그 선택) 외에는 막지 않는다.
  try {
    const MOUSE_MODES = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016];
    const MOUSE_ON_MODES = [1000, 1001, 1002, 1003]; // 앱이 마우스 리포팅을 원하는 실제 모드(휠 재주입 판단용)
    xterm.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      let hit = false;
      for (const p of params) if (MOUSE_MODES.includes(p)) { hit = true; if (MOUSE_ON_MODES.includes(p)) setAppMouseOn(true); }
      return hit; // 마우스 모드만 억제(활성), 그 외 DECSET은 xterm 기본 처리
    });
    xterm.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      let hit = false;
      for (const p of params) if (MOUSE_MODES.includes(p)) { hit = true; if (MOUSE_ON_MODES.includes(p)) setAppMouseOn(false); }
      return hit; // 마우스 모드 비활성만 억제, 그 외 DECRST은 xterm 기본 처리
    });
  } catch {}
  // 마우스 모드를 억제하면 xterm이 휠을 방향키(↑↓)로 바꿔 앱이 히스토리 이동으로 인식한다(스크롤=히스토리 회귀).
  // 앱이 마우스를 켠 상태(TUI/claude)면 휠을 가로채 SGR 마우스 휠 리포트를 PTY로 보내 앱이 자기 내용을
  // 스크롤하게 한다. 맨 셸(마우스 off)에선 개입하지 않아 xterm 기본 스크롤백이 그대로 동작한다.
  // 화면 좌표 → 터미널 셀(1-based). 휠·클릭 리포트가 같은 계산을 쓴다.
  function cellAt(clientX, clientY) {
    const point = mouseReportCell({ clientX, clientY });
    return { col: point.col + 1, row: point.row + 1 };
  }
  terminalInner.addEventListener("wheel", (e) => {
    const ws = getWs();
    if (!getAppMouseOn() || !ws || ws.readyState !== 1) return; // 앱이 마우스 안 씀 → xterm 기본 처리
    e.preventDefault(); e.stopPropagation();
    const { col, row } = cellAt(e.clientX, e.clientY);
    const dir = e.deltaY < 0 ? -1 : 1;
    const n = Math.max(1, Math.min(6, Math.round(Math.abs(e.deltaY) / 40)));
    // 화면 밖 드래그가 동작 중이면 그 기능이 이 휠 이벤트를 가져간다. 로드되지 않았으면 아무도 가져가지 않는다.
    if (callHook("chatcopy.wheel", { dir, lines: n, reportCol: col, reportRow: row, event: e })) return;
    const btn = dir < 0 ? 64 : 65; // 위 : 아래
    let seq = ""; for (let i = 0; i < n; i++) seq += "\x1b[<" + btn + ";" + col + ";" + row + "M";
    wsSend({ type: "pty.input", data: seq });
  }, { passive: false, capture: true });
  // 클릭 전달: 움직이지 않은 클릭만 herdr로 보낸다. 드래그는 로컬 선택(복사)이므로 보내지 않는다.
  // 이 구분이 herdr 기능 유지와 드래그 복사 보존의 핵심이다.
  let mdBtn = -1, mdX = 0, mdY = 0, mdHadSel = false, selOff = false;
  // Ctrl/Cmd+Shift+클릭은 자체 제스처(Finder에서 보기)다. 그런데 xterm은 shift+mousedown을
  // "선택 확장"으로도 소비해서, 같은 입력이 두 번 해석돼 화면에 의도치 않은 선택이 남는다.
  // 그 조합 동안에만 선택 기능을 끈다. mousedown 자체는 xterm에 그대로 전달해야 한다.
  // (링크 활성화는 mousedown에서 대상을 기억해 두므로, 이벤트를 막으면 링크 클릭이 통째로 죽는다.)
  function selService() { try { return (xterm._core && xterm._core._selectionService) || null; } catch (e2) { return null; } }
  // 내부 API가 없는 빌드로 폴백되면 증상만 남고 원인이 보이지 않으므로, 그때만 한 줄 남긴다.
  (function () { const ss = selService(); if (!ss || typeof ss.disable !== "function") blog("selection service API 없음 — Ctrl+Shift 클릭은 폴백(선택 지우기)으로 처리"); })();
  terminalInner.addEventListener("mousedown", (e) => {
    mdBtn = e.button; mdX = e.clientX; mdY = e.clientY;
    try { mdHadSel = !!(xterm.hasSelection && xterm.hasSelection()); } catch (e2) { mdHadSel = false; }
    // 일반 좌클릭 드래그만 화면 밖 추적 대상이다(수식키 조합은 자체 제스처).
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) callHook("chatcopy.dragStart", e);
    if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
      const ss = selService();
      if (ss && typeof ss.disable === "function" && typeof ss.enable === "function") { ss.disable(); selOff = true; }
      else { selOff = false; } // 내부 필드명이 바뀐 빌드 → 아래 mouseup에서 선택만 지운다(조용한 폴백)
    }
  }, true);
  // 가장자리 추적은 창 전체에서 받는다. 마우스가 터미널 밖으로 나가야 시작되는 동작이라
  // terminalInner 에만 걸면 그 순간부터 신호를 받지 못한다. 무엇을 쌓고 무엇을 복사할지는
  // 채팅 복붙이 소유하고, 여기서는 이벤트만 넘긴다.
  document.addEventListener("mousemove", (e) => callHook("chatcopy.dragMove", e), true);
  document.addEventListener("mouseup", (e) => callHook("chatcopy.dragEnd", e), true);
  terminalInner.addEventListener("mouseup", (e) => {
    const btn = mdBtn; mdBtn = -1;
    const ws = getWs();
    if (selOff) { selOff = false; const ss = selService(); if (ss) { try { ss.enable(); } catch (e2) {} } }
    else if (e.shiftKey && (e.metaKey || e.ctrlKey)) { try { xterm.clearSelection(); } catch (e2) {} } // 폴백
    if (!getAppMouseOn() || !ws || ws.readyState !== 1) return;   // 앱이 마우스 안 씀 → 건드리지 않음
    if (btn !== e.button || btn < 0) return;                  // 이 창 밖에서 시작한 클릭
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // 우리 커스텀 제스처(경로 열기·Finder·선택)
    if (Math.abs(e.clientX - mdX) > 3 || Math.abs(e.clientY - mdY) > 3) return; // 드래그 = 로컬 선택
    if (mdHadSel) return;                                     // 선택을 지우는 클릭은 herdr로 안 보냄
    if (terminalInner.querySelector(".xterm-cursor-pointer")) return; // 링크 위 클릭은 링크가 처리
    const { col, row } = cellAt(e.clientX, e.clientY);
    const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;    // 좌 · 가운데 · 우
    const at = ";" + col + ";" + row;
    wsSend({ type: "pty.input", data: "\x1b[<" + b + at + "M\x1b[<" + b + at + "m" });
  }, true);
  // herdr가 마우스를 쓰는 동안에는 우클릭도 herdr 몫이다. 브라우저 기본 메뉴가 가로채지 않게 한다.
  terminalInner.addEventListener("contextmenu", (e) => { if (getAppMouseOn()) e.preventDefault(); });
  // 한글 IME 글자 드롭 수정 (xtermjs #6045). xterm 조합 커밋 전송이 setTimeout(0) 지연-읽기라,
  // 빠르게 치면 다음 키가 예약된 전송을 선점(_finalizeComposition(false))하거나 지연 diff가 전진한
  // 값과 비교돼 글자가 유실된다(확인 결과: textarea.value 필드는 항상 온전하고 유실은 전송 경로에서만 발생).
  // 조합 헬퍼의 전송만 "동기"로 교체해 레이스 창 자체를 제거한다. 필드·오프셋(_compositionPosition)은
  // stock 값을 그대로 쓰고 전송 타이밍만 교정한다. 영어·백스페이스·붙여넣기 등 다른 경로는 바꾸지 않는다.
  const ch = xterm._core && xterm._core._compositionHelper;
  if (ch && ch._coreService && typeof ch._coreService.triggerDataEvent === "function" && ch._textarea && ch._compositionPosition) {
    ch._finalizeComposition = function (sendData) {
      this._compositionView.classList.remove("active");
      this._isComposing = false;
      this._isSendingComposition = false;
      if (sendData) {
        const t = this._textarea.value.substring(this._compositionPosition.start); // 이번 조합에서 커밋된 음절
        if (t.length > 0) this._coreService.triggerDataEvent(t, true);              // 동기 전송(지연 없음)
      }
    };
    ch._handleAnyTextareaChanges = function () {}; // 지연 diff 전송 무력화(동기 경로로 대체)
  } // 내부 필드명이 바뀐 빌드면 override를 건너뛰고 stock 유지(조용한 폴백)
  terminal.addEventListener("mousedown", () => setTimeout(() => xterm.focus(), 0)); // 클릭하면 입력 포커스
  // 입력: xterm이 키·IME·붙여넣기를 원시 바이트(onData)로 주므로 그대로 PTY(herdr)에 전달.
  xterm.onData((d) => {
    wsSend({ type: "pty.input", data: d });
    // 사용자가 프롬프트를 제출한 순간이 한 대화의 끝이다. 지목이 여기까지만 쌓이도록 서버에 알린다.
    // 붙여넣기로 넣는 알림 블록은 이 경로를 타지 않는다(wsSend로 직접 보낸다). 사용자가 입력한 것만 온다.
    const curTarget = getCurTarget();
    if (d.indexOf("\r") >= 0 && curTarget) wsSend({ type: "chat-submitted", pane: curTarget });
  });
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = (e.key || "").toLowerCase();
    // Shift+Enter = 줄바꿈(전송 아님). xterm 기본은 \r(전송)이라 가로채 줄바꿈 시퀀스를 보낸다.
    // herdr/에이전트가 kitty 키보드 프로토콜(\x1b[>7u)을 켜므로 Shift+Enter는 CSI-u \x1b[13;2u.
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // Chromium 한글 IME는 커밋용 Enter(keyCode 229 / isComposing)를 먼저, 이어서 실제 Enter
      // (keyCode 13)를 한 번 더 쏜다. 커밋용 Enter에서는 \n을 보내지 않고(중복 방지) IME가 글자를
      // 커밋하게 두되 xterm의 \r과 브라우저 기본동작만 막는다.
      if (e.isComposing || e.keyCode === 229) { e.preventDefault(); return false; }
      // 실제 Enter: Ctrl+J(=LF 0x0a)=chat:newline. 조합 글자는 compositionend에서 이미 동기 전송됐고,
      // \n을 setTimeout(0)로 그 뒤에 보내 "글자 → 줄바꿈" 순서를 보장한다(영어는 조합이 없어 그대로
      // \n 한 번). 이 위치가 유일한 \n 발신점이고, 이중 발신(2단 줄바꿈)을 막는다.
      e.preventDefault();
      setTimeout(() => wsSend({ type: "pty.input", data: "\n" }), 0);
      return false;
    }
    // 붙여넣기: Cmd+V를 가로채 클립보드를 읽고 xterm.paste()로 넣는다. xterm이 \r?\n→\r 정규화 +
    // bracketed-paste 모드 확인을 대신 처리하므로 수동으로 마커를 붙이지 않는다(Codex 진단 권고).
    if (e.metaKey && k === "v" && !e.ctrlKey && !e.altKey && window.acHost && window.acHost.readClipboard) {
      e.preventDefault();
      try { const txt = window.acHost.readClipboard(); if (txt) xterm.paste(txt); } catch (err) {}
      return false;
    }
    // 콘솔 소유 단축키는 xterm이 삼키지 않고(=false) document 전역 핸들러로 흘려 콘솔을 조작한다.
    // 터미널이 포커스돼 있어도 콘솔 내비/편집 단축키가 동작하게 한다.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) return false; // ⌥↑↓ 에이전트/Spaces, ⌥←→ 탭전환
    if (e.metaKey && (k === "r" || k === "s")) return false; // cmd+r 리네임 / cmd+s 저장
    if (e.ctrlKey && k === "t") return false;                // ctrl+t 탭 생성
    if (e.metaKey && k === "t") return false;                // cmd+t 탭 생성(콘솔로 흘림)
    if (e.metaKey && k === "w") return false;                // cmd+w = 선택한 herdr 세션 닫기(콘솔로 흘림). ctrl+w는 PTY로(셸 단어삭제).
    if (e.ctrlKey && e.shiftKey && k === "r") return false;  // ctrl+shift+r 리네임
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (k === "e" || k === "d" || k === "o")) return false; // ⌘⇧E 요소선택 / ⌘⇧D 스케치 / ⌘⇧O 분리(콘솔로 흘림)
    if (e.altKey && e.shiftKey && k === "t") return false;   // ⌥⇧t 탭 생성
    return true;
  });
  // 드래그 선택 시 자동 복사(herdr 기능 대응)는 채팅 복붙이 소유한다. 정리·클립보드·가드가
  // 전부 그 기능에 있다. 로드되지 않았으면 xterm 기본 선택만 남는다(⌘C 는 그대로 동작한다).
  xterm.onSelectionChange(() => callHook("chatcopy.selectionChanged"));
  const ro = new ResizeObserver(() => sendPtyResize());
  ro.observe(terminal);
  // 파일 드래그&드롭 → 절대경로 삽입(iTerm2식). Claude Code가 그 경로를 Read 도구로 이미지 로드한다.
  // Electron 기본 동작은 드롭 파일로 네비게이트하므로 반드시 preventDefault. 내부 요소 드래그(type≠Files)는 무영향.
  const hasFiles = (dt) => !!dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0;
  // "여기 놓으면 경로가 들어간다" 표시와 경로 삽입은 채팅 복붙이 갖는다. 여기 남는 것은
  // 하나뿐이다. 놓은 파일로 창이 넘어가는 Electron 기본 동작 차단이고, 기능을 꺼도
  // 막아야 한다(꺼도 창이 이동하면 안 된다).
  ["dragover", "drop"].forEach((ev) => document.addEventListener(ev, (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    callHook("chatcopy.dragHint", ev, !!(e.target && e.target.closest && e.target.closest("#terminal")));
  }));
  // 창 밖으로 나갔다 · 드래그가 끝났다 · 창이 포커스를 잃었다.
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) callHook("chatcopy.dragHint", "dragleave", false); });
  document.addEventListener("dragend", () => callHook("chatcopy.dragHint", "dragend", false));
  window.addEventListener("blur", () => callHook("chatcopy.dragHint", "blur", false));
  terminal.addEventListener("dragover", (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  terminal.addEventListener("drop", (e) => {
    callHook("chatcopy.dragHint", "drop", false);
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    callHook("chatcopy.dropFiles", files);
  });
  startPty();
}

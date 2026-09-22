// 브라우저 요소 지목. 서버 동기 pick 모드, 호버, 문서 DOM 해석과 선택 전달을 맡는다.
//
// 소유 범위
//   pickMode·호버·연속 선택 상태, 브라우저 command 호출, docx DOM 경로/히트테스트와 request generation.
//   지목 블록의 코드 위치 줄(codeLines). 어느 파일 몇 줄인지 적는 형식은 여기가 정본이다.
//   그 위치를 찾는 일은 소유하지 않는다. server/pick-source.js 가 찾고 이 파일은 적기만 한다.
//
// 제공 API
//   초기화·모드 query/command, 문서 DOM query, 선택 전달·블록 변환 command와 generation 발급 command.
//
// 의존 대상
//   browser/webview-store·browser/webview·browser/record, center/tab-store와 sheet/render를 import한다.
//   main이 소유하는 core/DOM 값과 아직 main에 남은 webview 주입·sheet 히트테스트, 런타임 접근자는 init에서 받는다.
//
// 유지 조건
//   pick 모드의 진실 소스는 서버 방송 하나이며 모든 webview를 함께 켜고 끈다. 고른 순간의 탭·그림·
//   구조화 원본을 보존하고, 20초 연속 묶음·PTY bracketed paste·녹화 합류·문서 호버 판정을 유지한다.
//   코드 위치를 찾지 못한 것이 지목을 막는 이유가 되면 안 된다. 해석은 시간 제한을 두고 실패하면 그대로 진행한다.
//
// 영향 범위
//   DOM #wv-pick/#browserview와 host cursor·pickShot·setPickMode·framesHover, /browser-cmd,
//   POST /pick-source(server/pick-source.js), ws/PTY에
//   접근한다. 이 API를 바꾸면 import 하는 파일을 함께 확인한다:
//   grep -rl 'browser/pick.js"' web/js

import { callHook } from "../core/hooks.js";
import { getAiTargets, getTabHandles } from "./ai-state.js";
import { getActiveTabId, getCenterSpace, getCurrentTabs } from "../center/tab-store.js";
import { bindRecordPick, recording, recNote, recPush } from "./record.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import { getWebview, getWebviewIds } from "./webview-store.js";
import { activeWv } from "./webview.js";

let $, BROWSER_MODE, bNote, wsSend, fileview, setOrca, pickSheetElementAt;
let getCurTarget, uiToken, getXterm;
export let pickMode = false;
let hoverTabEl = null;
let lastPickAt = 0, lastPickTab = null, pickBurst = 0;

export function initPick(deps) {
  ({ $, BROWSER_MODE, bNote, wsSend, fileview, setOrca, pickSheetElementAt,
    getCurTarget, uiToken, getXterm } = deps);
  bindRecordPick({ pickBlock, acBrowserCmd });
  wirePickCursor();
  $("#wv-pick").addEventListener("click", () => togglePickMode());
}

export function clearPickHover(el) {
  if (el === hoverTabEl) {
    hoverTabEl.classList.remove("pick-hover");
    hoverTabEl = null;
  }
}

export function docxCssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let e = el, depth = 0;
  for (; e && e.nodeType === 1 && e !== document.body && depth < 8; e = e.parentElement, depth++) {
    let s = e.tagName.toLowerCase();
    if (e.classList.length) s += "." + Array.from(e.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    parts.unshift(s);
  }
  return parts.join(" > ");
}
// 클릭 판정(pickDocxAt)과 호버 미리보기(docxPickHoverAt)가 같은 대상 해석을 쓴다. 따로 두면
// 언젠가 둘이 갈라져 "상자는 여기 뜨는데 클릭은 저기로 간다"는 불일치가 생긴다.
export function docxPickElementAt(target) {
  if (!pickMode) return null;
  const t = callHook("viewer.activeDocxTab") || null;
  if (!t) return null;
  // 이 값은 뷰어가 로드될 때 만들어지고 pickrec 은 뷰어보다 먼저 로드되므로, 참조를 붙잡아 두면 null 이다.
  const root = callHook("viewer.docxRoot", $("#docxview"));
  if (!root || !target || !target.closest || !root.contains(target)) return null;
  const el = target.closest("[class]") || target;
  if (el === root) return null; // 패널 바깥 여백은 지목 대상 아님
  return { t, el };
}

// iris-browser와 같은 서버 엔드포인트를 렌더러에서 쓰기 위한 얇은 호출기(observe 로그 수집용).
async function acBrowserCmd(cmd, args) {
  const res = await fetch("/browser-cmd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, args: args || {} }) });
  return res.json();
}

// 서버가 주소에서 루트 폴더를 찾고 그 안에서 이 요소를 찾는다. 창은 파일을 읽지 않는다.
// 오래 걸리면 중단한다. 사용자는 클릭 뒤에 블록이 붙기를 기다리고 있다.
async function pickSourceOf(p) {
  // 해석기가 읽는 필드를 하나라도 빠뜨리면 그 필드가 하는 일이 오류 없이 동작하지 않는다. 확인 결과:
  // selector·html 을 안 보내서 조상·자식 이름 순위와 안쪽 속성값 후보가 production 에서 한 번도
  // 돌지 않았고, `.ghead` 의 답으로 다른 화면(.guide)의 규칙이 나갔다. 검사가 함수만 확인하고 있었다.
  const body = JSON.stringify({ pick: {
    id: p.id, cls: p.cls, attrs: p.attrs, text: p.text, tag: p.tag, url: p.url, src: p.src,
    pageUrl: p.pageUrl, selector: p.selector, usel: p.usel, html: p.html,
  } });
  const req = fetch("/pick-source", { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
  const out = await Promise.race([req, new Promise((res) => setTimeout(() => res(null), 3000))]);
  return out && out.ok ? out : null;
}

// 요소 선택 모드의 진실 소스는 서버(pickModeOn) 한 곳이다. 창이 각자 boolean을 뒤집으면
// 공유 브라우저 창과 스페이스 브라우저 창이 서로 반대 상태로 갈라지고, 그 뒤로는 무엇을 눌러도
// 둘이 함께 켜지지 않는다. 창은 "뒤집어 달라"고 요청만 하고 적용은 방송을 받아서 한다.
export function hasSheetContext() {
  const t = callHook("viewer.activeSheetTab");
  const grid = callHook("viewer.sheetGrid");
  return !!(t && grid && fileview.contains(grid));
}
// sheet와 같은 이유로 문서 탭도 서버의 "픽 대상 없음" 게이트(tabReg.size===0)를 통과해야 한다.
// docx엔 webview가 없어 tabReg에 잡히지 않으므로, 알리지 않으면 켜지지 않는다.
export function hasDocxContext() {
  return !!callHook("viewer.activeDocxTab");
}
export function togglePickMode() { wsSend({ type: "pick-mode", op: "toggle" }); }
export function applyPickMode(on) {
  pickMode = !!on;
  const r = activeWv();
  // 두 창(메인/분리)이 같은 문서를 쓰지만 레이아웃에 따라 없는 요소가 있을 수 있어, 없어도 오류가 나지 않게 한다.
  $("#wv-pick")?.classList.toggle("on", pickMode);
  $("#browserview")?.classList.toggle("picking", pickMode);
  // 이 창의 모든 webview에 적용한다. 활성 탭에만 걸면 끌 때 비활성 탭이 켜진 채 남는다.
  for (const id of getWebviewIds()) { const rec = getWebview(id); if (rec && rec.el) setOrca(rec.el, pickMode); }
  document.body.classList.toggle("picking-tabs", pickMode); // 탭도 지목 대상임을 알리는 어포던스
  if (!pickMode) { hoverTabEl?.classList.remove("pick-hover"); hoverTabEl = null; }
  try { window.acHost && acHost.setPickMode && acHost.setPickMode(pickMode); } catch {} // OS 커서 추적 on/off
  bNote.textContent = pickMode
    ? (r ? "요소 선택 모드: 요소를 클릭하면 현재 터미널로 전달됩니다. 앱 화면은 한 번 탭해 확인하고 두 번 탭해 보냅니다."
         : "요소 선택 모드: 이 창엔 브라우저 탭이 없습니다. 앱 화면은 한 번 탭해 확인하고 두 번 탭해 보냅니다.")
    : "선택 모드 꺼짐.";
}
// OS 커서(스크린 좌표) → 활성 webview의 게스트 좌표. 이 창이 포커스가 없어도 하이라이트가 따라온다.
// window.screenX/Y는 이 렌더러 콘텐츠 영역의 화면 원점이라, webview의 rect를 더하면 게스트 원점이 나온다.
function wirePickCursor() {
  let lastX = -1, lastY = -1;
  hoverTabEl = null;
  try {
    window.acHost && acHost.onCursor && acHost.onCursor((pt) => {
      if (!pickMode) return;
      // 맨 위가 아니면(다른 앱이 앞에 있거나 우리 창이 겹쳐 가려졌으면) 아무것도 짚지 않는다.
      // 겹친 표면이 다 같이 반응하면 어느 것을 고르는 중인지 알 수 없다.
      if (!pt) {
        if (hoverTabEl) { hoverTabEl.classList.remove("pick-hover"); hoverTabEl = null; }
        const r0 = activeWv();
        if (r0 && r0.el && r0.ready) { try { r0.el.send("ac-cursor-guest", null); } catch (e) {} }
        lastX = lastY = -1;
        return;
      }
      // 호스트 UI(탭 스트립·docx 패널) 히트테스트는 webview 유무와 무관하게 항상 계산한다. 아래
      // activeWv() 가드가 이 위에 있으면 여기서 전체가 return 되어, docx/sheet 탭처럼 webview가
      // 없는 창에서는 이 블록이 실행되지 않는다. webview 게스트로 좌표를 넘기는 부분만 뒤로 미룬다.
      const under = pt ? (document.elementFromPoint(pt.x - window.screenX, pt.y - window.screenY) || null) : null;
      const overTab = under?.closest?.(".ctab") || null;
      const overGroup = under?.closest?.(".tgroup") || null; // 그룹 칩도 지목 대상이다
      const overBmk = under?.closest?.(".bmk") || null;      // 북마크는 "여기로 가라"는 지목이다
      // AGENTS 목록의 세션 한 줄. 여기서 고른 것은 화면이 아니라 "저 세션"이다.
      const overAgent = under?.closest?.(".srow") || null;
      const overDocx = docxPickElementAt(under); // docx 본문·헤더·툴바도 같은 좌표 기반 호버를 탄다
      const overCell = callHook("viewer.sheetCellAt", under) || null;   // Sheet 칸
      const overSheet = pickSheetElementAt(under); // Sheet 메뉴바·도구모음·수식입력줄도 같은 좌표 기반 호버
      const want = overTab && overTab.dataset.tab && getWebview(overTab.dataset.tab) ? overTab
        : (overGroup && overGroup.dataset.group ? overGroup
        : (overBmk && overBmk.dataset.url ? overBmk
        : (overAgent && overAgent.dataset.target ? overAgent
        : (overDocx ? overDocx.el
        : (overCell ? overCell
        : (overSheet ? overSheet.el : null))))));
      if (want !== hoverTabEl) {
        hoverTabEl?.classList.remove("pick-hover");
        hoverTabEl = want;
        hoverTabEl?.classList.add("pick-hover");
      }
      const r = activeWv(); if (!r || !r.el || !r.ready) return; // 여기부턴 webview 게스트 전용
      const b = r.el.getBoundingClientRect();
      const x = Math.round(pt.x - (window.screenX + b.left));
      const y = Math.round(pt.y - (window.screenY + b.top));
      if (x < 0 || y < 0 || x > b.width || y > b.height) return; // webview 밖
      // 좌표가 그대로여도 entered 는 전달해야 한다. 다른 앱에서 이 창을 클릭해 올라오는 순간
      // 커서는 대개 제자리에 있어서, 같은 좌표라고 걸러 버리면 그 신호가 사라진다.
      if (x === lastX && y === lastY && !pt.entered) return;
      lastX = x; lastY = y;
      // entered 는 "남의 앱에 가려져 있다가 방금 올라왔다"는 호스트의 판정이다. 게스트는 이 뒤
      // 첫 클릭을 창을 부르는 클릭으로 보고 삼킨다(요소로 만들지 않는다).
      try { r.el.send("ac-cursor-guest", pt.entered ? { x, y, entered: true } : { x, y }); } catch {}
      // 위 경로는 최상위 문서에만 전달된다. iframe 위에서는 하이라이트가 갱신되지 않는다.
      // 같은 좌표로 마우스 이동을 한 번 흘리면 크로미움이 그 자리의 프레임으로 보내 준다.
      try {
        const wcid = r.el.getWebContentsId ? r.el.getWebContentsId() : null;
        if (wcid && window.acHost && acHost.framesHover) acHost.framesHover(wcid, x, y);
      } catch {}
    });
  } catch {}
}
// 선택 요소를 현재 터미널(에이전트)로 전달한다. 라벨 블록 형식이며, 사용자는 이어서 지시만 입력한다.
// 브라우저 신원(탭 라벨·URL·제목)을 명시해 "어느 페이지의 요소인지" 밝히고, DOM 식별자(선택자·
// 속성·검색키·HTML)로 AI가 소스를 직접 grep해 코드 위치를 특정할 수 있게 한다.
// 요소 pick 전달 라우터. 분리 브라우저 창엔 터미널(PTY)이 없으므로 서버 경유로 콘솔에 relay하고,
// 콘솔이 자기 터미널에 주입한다(요소 모드는 분리 창에서도 동작해야 하므로).
export async function deliverPick(p, fromTabId) {
  if (fromTabId && !p.tabId) p.tabId = fromTabId;   // 어느 탭에서 골랐는지는 pick과 함께 다닌다
  // 고른 그 순간의 이미지를 함께 남긴다. 나중에 따로 찍으면 스크롤·hover·펼침 상태가 이미 달라져
  // 있어 같은 화면이 아니다. 실패하면 이미지 없이 진행한다. 선택 자체가 막히면 안 된다.
  try {
    const shotRec = getWebview(p.tabId);
    const sel = p.usel || p.selector;
    if (shotRec && shotRec.wc && sel && window.acHost && acHost.pickShot) {
      p.shot = await acHost.pickShot(shotRec.wc, sel);
    }
  } catch {}
  // 코드 위치도 지금 찾는다. 지목 블록은 이대로 다른 세션·다른 모델에게 건네지므로, 받은 쪽이
  // 다시 grep 을 도는 일이 없어야 한다. 로컬에서 도는 페이지의 코드는
  // 정적이라 이 검색은 한 번만 돌면 되고, 그 한 번은 고른 사람 쪽에서 도는 것이 맞다.
  // 찾지 못해도 그대로 진행한다. 소스가 없다는 것이 지목을 막는 이유가 되면 안 된다.
  try {
    if (/^https?:/i.test(p.url || "")) p.code = await pickSourceOf(p);
  } catch {}
  // 여러 개를 고르면 블록도 여러 개가 나란히 붙는다. 라벨이 없으면 어느 글이 어느 요소인지,
  // browser_picks가 준 목록의 무엇과 같은지 맞출 수 없으므로, 고르는 순간 이름을 붙인다.
  if (!p.pid) p.pid = "p" + Math.random().toString(36).slice(2, 6);
  // 녹화 중에는 곧바로 채팅으로 보내지 않는다. 조작 흐름과 같은 타임라인에 쌓아두고
  // 녹화 종료 때 한 번에 넘긴다. 선택 시점이 기록에 남아 순서가 보존된다.
  if (recording) {
    recPush({ k: "pick", pick: p, el: { tag: p.tag, id: p.id || null, sel: p.selector, text: p.text || null, shot: p.shot || null } });
    recNote("요소 기록됨. 녹화 종료 시 함께 전달됩니다.");
    return;
  }
  if (BROWSER_MODE) {
    wsSend({ type: "pick-relay", pick: p }); bNote.textContent = "요소 전달됨 → 콘솔 터미널.";
    try { window.acHost && acHost.refocusConsole && acHost.refocusConsole(); } catch {} // 채팅 포커스 복귀
    return;
  }
  deliverPickLocal(p);
}
// 알림은 사실만 싣는다. 권위를 부인하는 문장과 권한을 설명하는 문장을
// 매 픽에 붙이면 픽 하나의 4분의 1이 같은 글이 된다. 권한 제한은 서버·MCP가 관리하므로
// 그런 설명은 보호 효과 없이 길이만 늘린다.
// 코드 위치 줄. 맨 위에 둔다. 받은 쪽이 가장 먼저 할 일이 그 파일을 여는 것이기 때문이다.
// 한 파일에 여러 줄이면 줄 번호를 모으고, 파일이 여럿이면 같은 라벨로 줄을 더 쌓는다.
// 프레임워크가 스스로 짚어 준 자리(React·Vue)는 검색 결과보다 정확하므로 그것을 먼저 쓴다.
export function codeLines(p) {
  const out = [];
  const c = p.code || null;
  const fw = p.src || null;
  // 한 파일에서 여러 줄이 걸리면 파일 이름은 한 번만 적는다. 아주 긴 줄에만 열 번호가 붙는다.
  // 생성기가 한 줄에 다 담은 CSS 는 줄 번호만 받아 열면 그 안에서 다시 찾아야 한다.
  const group = (hits) => {
    const byFile = new Map();
    for (const h of hits || []) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file).push(h.col ? `${h.line}:${h.col}` : h.line);
    }
    return [...byFile].map(([f, ls]) => `${f}:${ls.join(", ")}`);
  };
  const made = (hits) => (hits || []).filter((h) => !h.side);
  let found = 0;
  if (fw && fw.file) { out.push(`소스: ${fw.file}${fw.line ? ":" + fw.line : ""} (${fw.framework} dev)`); found++; }
  else for (const one of group(made(c && c.markup))) { out.push(`소스: ${one}`); found++; }
  for (const one of group(made(c && c.style))) { out.push(`스타일: ${one}`); found++; }
  for (const one of group(made(c && c.script))) { out.push(`동작: ${one}`); found++; }
  // 검사 파일과 글은 그 이름을 언급할 뿐 그 요소를 만들지 않으므로, 그 이름 그대로 싣는다.
  // "동작" 으로 적으면 받은 쪽이 그 줄을 그 요소가 하는 일로 읽는다(확인 결과).
  for (const label of ["검사", "글"]) {
    const only = (hits) => (hits || []).filter((h) => h.side === label);
    const all = [...only(c && c.markup), ...only(c && c.style), ...only(c && c.script)];
    for (const one of group(all)) { out.push(`${label}: ${one}`); found++; }
  }
  if (fw && fw.component) out.push(`컴포넌트: <${fw.component}> (${fw.framework})`);
  const where = c && c.host ? ` (${c.host}${c.port && c.port !== 80 && c.port !== 443 ? ":" + c.port : ""})` : "";
  if (c && c.root) {
    // 위 줄들의 경로는 이 폴더 기준 상대다. 이 한 줄이 있어야 받은 쪽이 절대경로를 만들 수 있다.
    out.push(`기준 폴더: ${c.root}${where}` + (found ? "" : ` (${c.why || "이 요소를 소스에서 못 찾음"})`));
    // 위 경로는 소스이고 지금 화면을 내주는 것은 그 사본이다. 이 줄이 없으면 받은 쪽이 소스를
    // 고쳐 놓고 화면이 바뀌지 않는다고 판단한다. 사본은 다시 설치할 때까지 이전 코드를 그대로 내준다.
    if (c.copy) out.push(`돌고 있는 사본: ${c.copy}`);
  } else if (c && c.local) {
    // 로컬인데 루트를 찾지 못한 경우다. 아무 줄도 내지 않으면 받은 쪽은 이 기능이 동작했는지 알 수 없어,
    // 결국 스스로 grep 을 돈다(확인 결과: 이미 종료된 포트의 페이지).
    // 원격은 아무 줄도 내지 않는다. 거기에는 찾을 소스가 없다.
    out.push(`소스: 못 찾음${where} (${c.why || "기준 폴더를 잡지 못함"})`);
  }
  return out;
}
// 선택한 요소를 사람이 읽고 AI가 grep할 수 있는 블록 문자열로. 즉시 전달과 녹화 기록이 같은 형식을 쓴다.
export function pickBlock(p) {
  const idStr = p.id ? "#" + p.id : "";
  const clsStr = p.cls && p.cls.length ? "." + p.cls.slice(0, 4).join(".") : "";
  // 어느 탭에서 고른 것인지는 pick이 알고 있다. "지금 콘솔이 보고 있는 탭"을 적으면
  // 분리창이나 다른 탭에서 고를 때 잘못된 탭 이름이 붙는다. 이름은 서버가 매긴 핸들을 쓴다.
  // 받은 쪽이 `--tab @핸들`로 그대로 부를 수 있어야 한다.
  const pickedId = p.tabId || getActiveTabId(getCenterSpace());
  const tab = getCurrentTabs().find((t) => t.id === pickedId);
  const tabHandles = getTabHandles();
  const handle = tabHandles[pickedId] || null;
  // 이 세션이 지금 무지정 명령을 보내는 탭. 서버가 세션마다 하나씩 내려주며 창이 추정하지 않는다.
  const aiTargets = getAiTargets(), curTarget = getCurTarget();
  const mineT = aiTargets.find((x) => x && x.pane === curTarget);
  const curHandle = (mineT && mineT.tabId && tabHandles[mineT.tabId]) || null;
  // docx/sheet 탭은 이 창의 getCurrentTabs()에 잡히지 않는다(다른 창에서 렌더되는 탭이라). tab이
  // undefined면 "브라우저"라는 가짜 이름 대신 pick이 이미 들고 온 실제 제목을 쓴다
  // (확인 결과: "탭 브라우저"로 잘못 표시됐다).
  const tabLabel = handle ? "@" + handle + ((tab && tab.name) ? "  " + tab.name : "")
    : ((tab && tab.label) ? tab.label : (p.title || "브라우저"));
  // 머리글의 주소는 "그 탭의 주소"다. iframe 안에서 고르면 p.url 은 그 안쪽 문서의 주소라,
  // 그대로 머리글에 쓰면 받은 쪽이 그리로 이동해 감싸는 화면을 잃는다(확인 결과:
  // 감싸는 페이지의 탭에서 골랐는데 iframe 안 주소가 나갔다). 요소가 있는 문서 주소는 따로 한 줄로 남긴다.
  const rec = getWebview(pickedId);
  const tabUrl = (rec && rec.url) || (tab && tab.url) || null;
  const headUrl = tabUrl || p.url;
  const inFrame = !!(p.url && headUrl && p.url !== headUrl);
  const lines = [
    ...codeLines(p),
    p.title ? `제목: ${p.title}` : null,
    `요소: <${p.tag}${idStr}${clsStr}>` + (p.text ? ` "${p.text}"` : ""),
    `선택자: ${p.selector}`,
    p.usel && p.usel !== p.selector ? `재현 선택자: ${p.usel}` : null,
    // 속성 줄은 싣지 않는다. HTML 줄이 같은 속성을 전부 담고 있어 중복이다. 원본은 browser_picks.
    `요소 코드: ${p.html}`,
    // 연속으로 고른 것들은 한 벌이다. 몇 개째인지 적어 두지 않으면 사용자가 3개를 고르고 지시를
    // 한 줄 쓴 뒤, 앞의 둘이 그 지시와 상관없는 옛 선택인지 같은 벌인지 구분할 수 없다.
    p.burst > 1 ? `연속 ${p.burst}번째` + (p.otherTab ? " · 앞과 다른 탭" : "") : null,
    // 고른 것은 요소이지 대상 탭이 아니다. 이것을 문장으로 길게 설명하지 않는다. 필요한 사실은
    // "지정 없는 명령이 어디로 가는가" 하나다. 그 탭이 지금 고른 탭과 같으면
    // 새 정보가 없으니 줄 자체를 뺀다. 대상 탭은 서버가 보내주는 값(ai-targets)으로 판정한다.
    handle && curHandle && curHandle !== handle ? `대상 탭: @${curHandle}` : null,
    // 그 요소가 iframe 안에 있으면 그 문서의 주소를 따로 적는다. 머리글에 이 주소를 쓰면
    // 받은 쪽이 그리로 바로 이동해 버리는데, 그 페이지는 감싸는 화면 없이는 열리지 않는다
    // (확인 결과: 감싸는 페이지 없이 iframe 안쪽 문서만 직접 열면 미인증으로 거부된다). 갈 곳은 탭 주소, 찾을 곳은 이 주소다.
    inFrame ? `요소가 있는 안쪽 문서: ${p.url}` : null,
    // 고른 그 순간에 그 요소만 잘라 찍은 이미지. 나중에 따로 찍으면 스크롤·펼침 상태가 달라져 있다.
    p.shot ? `요소 그림: ${p.shot}` : null,
  ];
  return noticeBlock(`요소 선택 ${p.pid ? "#" + p.pid + " " : ""}· 탭 ${tabLabel} · ${headUrl}`, lines);
}
export function deliverPickLocal(p) {
  const curTarget = getCurTarget();
  if (!curTarget) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  // 요소를 고른 것 자체가 "이 탭의 이것을 봐 달라"는 사용자 행위다. 그러니 그 순간 그 탭을 이 세션에
  // 등록까지 한다. 핸들만 적어 보내면 받은 쪽이 그 탭을 쓸 권한이 없을 때 거기서 막히고
  // 사용자가 앱에서 따로 지목해야 한다. 판단할 것이 없는 일은 판단시키지 않는다.
  const pickedTab = p.tabId || getActiveTabId(getCenterSpace());
  // 한 벌인지는 시간으로 구분한다. 20초 안에 이어서 고른 것은 같은 지시에 딸린 한 벌로 본다.
  const now = Date.now();
  pickBurst = (now - lastPickAt < 20000) ? pickBurst + 1 : 1;
  p.burst = pickBurst;
  p.otherTab = !!(pickBurst > 1 && lastPickTab && pickedTab && lastPickTab !== pickedTab);
  lastPickAt = now; lastPickTab = pickedTab || null;
  if (pickedTab) {
    try { wsSend({ type: "browser-target-set", pane: curTarget, tabId: pickedTab, via: "pick", token: uiToken() }); } catch (e) {}
  }
  // 구조화된 원본도 함께 보관한다. 터미널에 붙는 글은 사람이 읽는 형식이고, 도구로 다시 꺼내
  // 쓰려면 필드가 살아 있어야 한다(선택자·소스 파일·속성).
  try { wsSend({ type: "ai-pick", pane: curTarget, tabId: pickedTab || null, pick: p }); } catch (e) {}
  const block = pickBlock(p);
  // 멀티라인 블록을 프롬프트에 넣되 제출되지 않게 bracketed paste로 주입한다. Claude Code가 붙여넣기
  // 텍스트로 받아 내부 개행으로 두고, 사용자가 이어서 지시를 타이핑한 뒤 Enter로 제출한다.
  wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  bNote.textContent = "요소 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.";
  const xterm = getXterm();
  if (xterm) setTimeout(() => xterm.focus(), 0);
}

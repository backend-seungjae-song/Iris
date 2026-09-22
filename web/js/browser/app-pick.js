// 브라우저 캡처 조립과 네이티브 앱 요소 선택 전달. 현재 에이전트로 보내는 상위 경계다.
//
// 소유 범위
//   record → browser pick 초기화 순서, 앱 pick 문구·20초 연속 묶음·PTY/서버 전달.
//   record/pick의 상태·판정과 pick-host의 화면 hit-test는 소유하지 않는다.
//
// 제공 API
//   initAppPick(deps)와 WebSocket app-pick 분기가 부르는 deliverAppPickLocal(p).
//
// 의존 대상
//   browser/{record,pick,pick-host}, center/tabs, panel/{terminal,touch-drag}의 도메인 API를 import한다.
//   main이 소유하는 $·BROWSER_MODE·bNote·fileview·wsSend·uiToken과 교체되는 curTarget 접근자는 init에서 받는다.
//
// 유지 조건
//   record를 pick보다 먼저 초기화하고, 앱 pick은 브라우저 녹화 타임라인에 넣지 않는다.
//   앱 pick은 20초 연속 묶음·bracketed paste·소스 절대경로와 상대 chain 표기를 그대로 유지한다.
//
// 영향 범위
//   main.js의 옛 record/pick init 자리와 WebSocket app-pick 분기, browser/{record,pick,pick-host}의 init 계약,
//   panel/touch-drag.js의 프레임/Orca 주입, center/tabs.js의 현재 file owner, panel/terminal.js의 xterm focus,
//   server/app-pick.js·server/index.js의 ai-app-pick payload와 bin/iris-mcp.mjs의 app_picks 결과 계약.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/app-pick.js

import { getXterm } from "../panel/terminal.js";
import { injectAllFrames, setOrca } from "../panel/touch-drag.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import { initPick } from "./pick.js";
import { pickSheetElementAt } from "./pick-host.js";
import { initRecord } from "./record.js";

let bNote, wsSend, getCurTarget;
let lastAppPickAt = 0, appPickBurst = 0;

export function initAppPick(deps) {
  const { $, BROWSER_MODE, fileview, uiToken } = deps;
  ({ bNote, wsSend, getCurTarget } = deps);

  // 게스트 JS가 볼 수 없는 네이티브 이벤트 구독은 기존 최상위 부작용과 같은 위치에서 시작한다.
  initRecord({
    BROWSER_MODE, bNote, wsSend, injectAllFrames,
    getCurTarget, getXterm,
  });
  // 커서 구독과 도구 버튼 연결은 기존 최상위 부작용과 같은 위치에서 시작한다.
  initPick({
    $, BROWSER_MODE, bNote, wsSend, fileview, setOrca, pickSheetElementAt,
    getCurTarget, uiToken, getXterm,
  });
}

function appPickBlock(p) {
  const where = p.file ? `${p.file}${p.line ? ":" + p.line : ""}` : null;
  // 경로는 위젯 경계다. 각 칸이 "그 위젯이 쓰인 파일:줄"이라 어느 계층이든 그대로 열 수 있다.
  // 루트 기준 상대경로로 보여주되(읽기 위해), 맨 위 소스 줄은 절대경로를 그대로 둔다(열기 위해).
  const rel = (f) => (p.root && f && f.startsWith(p.root + "/") ? f.slice(p.root.length + 1) : f);
  const chain = (p.chain || []).map((c, i) => `  ${i ? "← " : ""}${c.name} — ${rel(c.file)}${c.line ? ":" + c.line : ""}`);
  // 지금 화면의 값. 코드 위치만 오면 "왜 이 값이 여기 나오나"를 물을 수 없으므로, 가리킨 것 안의 글자,
  // 값을 담은 속성, 그리고 한 단계 위의 글자(옆에 붙은 라벨)를 함께 싣는다.
  // 값은 자기 줄을 달고 온다. 고른 위젯의 줄과 값이 적힌 줄은 대개 다르다. 값만 실으면
  // "이 글자를 바꿔 달라"는 지시에 받는 쪽이 고른 위젯의 줄(감싼 Padding)을 연다.
  // 이전 픽 기록은 값이 문자열이라 그대로도 읽히게 둔다.
  const vals = (p.values || []).slice(0, 8).map((x) => (typeof x === "string" ? { value: x } : (x || {})));
  const props = (p.props || []).slice(0, 6).map((x) => `${x.name}=${JSON.stringify(x.value)}`);
  // 주변은 트리로 그린다. "쿠폰번호 · 9000000000162"처럼 값만 나열하면 어느 값이 코드
  // 어디에 있는지 알 수 없다. 질문의 대상이 대개 그것이다. 감싼 위젯을 열고 닫고, 그 안의
  // 값마다 자기 줄을 단다. 파일이 감싼 쪽과 같으면 줄 번호만, 다르면 파일까지 적는다.
  const a = p.around || {};
  const items = (a.items || []).slice(0, 8);
  const at = (f, l) => (!l ? "" : (f && rel(f) !== rel(a.file) ? ` ${rel(f)}:${l}` : ` :${l}`));
  const tag = a.name || "?";
  // "고른 것" 표시는 값이 아니라 위치로 맞춘다. 같은 글자가 화면에 여러 개면 엉뚱한 줄에 붙는다.
  const isMine = (x) => vals.some((v) => v.value === x.value && (!v.line || !x.line || v.line === x.line));
  const tree = items.length ? [
    `주변: <${tag}${a.file ? " " + rel(a.file) + (a.line ? ":" + a.line : "") : ""}>`,
    ...items.map((x) => `  <${x.widget || "?"}${at(x.file, x.line)}> ${JSON.stringify(x.value)}`
      + (isMine(x) ? "  ← 고른 것" : "")),
    `</${tag}>`,
  ] : [];
  // 지금 살아 있는 화면들. 뒤로 갈수록 위에 쌓인 것이다. 같은 화면에 진입점이 여럿일 때
  // "어디서 들어간 것인가"는 위젯 경로로는 안 나온다. 화면이 하나뿐이면 새 정보가 없어 뺀다.
  const screens = (p.screens || []).filter(Boolean);
  const screenLine = screens.length > 1
    ? `화면: ${screens.slice(0, -1).join(" → ")} → ${screens[screens.length - 1]} (지금)`
    : null;
  // 값이 적힌 줄. 고른 위젯과 같은 파일이면 줄 번호만, 다르면 파일까지.
  const vat = (v) => (!v.line ? "" : (v.file && rel(v.file) !== rel(p.file) ? ` ${rel(v.file)}:${v.line}` : ` :${v.line}`));
  // 가려진 계층이 있었다는 사실. 모달·시트가 떠 있으면 그 뒤 후보를 빼고 고른다. 몇 개를 뺐는지까지
  // 적어 두면, 뒤가 잡혔을 때 "못 걸렀다"인지 "가린 계층이 없었다"인지를 픽 기록에서 구분할 수 있다.
  const layer = p.layer && p.layer.hidden > 0
    ? `층: 맨 위에서 골랐고, 뒤에 가려진 후보 ${p.layer.hidden}개는 뺐습니다`
    : null;
  const lines = [
    // 열 번호는 붙이지 않는다. 감싼 위젯의 여는 괄호 위치라 어느 픽이나 같은 값이 나오고,
    // 파일:줄이면 그 코드를 여는 데 충분하다.
    where ? `소스: ${where}` : "소스: (디버그 실행이 아니라 위치 없음)",
    screenLine,
    `위젯: ${p.widget}` + (p.stateful ? " · stateful" : ""),
    layer,
    vals.length ? `지금 값: ${vals.map((v) => JSON.stringify(v.value) + vat(v)).join(" · ")}` : null,
    props.length ? `속성: ${props.join(" · ")}` : null,
    ...tree,
    chain.length ? "경로:" : null,
    ...chain,
    p.local === false ? "패키지 위젯 (프로젝트 코드 아님)" : null,
    p.burst > 1 ? `연속 ${p.burst}번째` : null,
  ];
  return noticeBlock(`앱 요소 선택 ${p.pid ? "#" + p.pid + " " : ""}· ${p.app}`, lines);
}

export function deliverAppPickLocal(p) {
  const curTarget = getCurTarget();
  if (!curTarget) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  if (!p.pid) p.pid = "p" + Math.random().toString(36).slice(2, 6);
  // 브라우저 픽과 같은 규칙이다. 20초 안에 이어 고른 것은 한 지시에 딸린 한 벌이다.
  const now = Date.now();
  appPickBurst = (now - lastAppPickAt < 20000) ? appPickBurst + 1 : 1;
  p.burst = appPickBurst; lastAppPickAt = now;
  // 녹화는 브라우저 조작의 타임라인이다. 앱 선택을 그 줄에 끼우면 재생할 수 없는 항목이 섞이므로
  // 여기서는 모으지 않고 곧바로 보낸다.
  try { wsSend({ type: "ai-app-pick", pane: curTarget, pick: p }); } catch (e) {}
  wsSend({ type: "pty.input", data: "\x1b[200~" + appPickBlock(p) + "\x1b[201~" });
  bNote.textContent = "앱 요소 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.";
  if (getXterm()) setTimeout(() => getXterm().focus(), 0);
}

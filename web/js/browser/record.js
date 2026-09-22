// 브라우저 재현(녹화). 게스트 기록기, 녹화 대상 탭, 타임라인 변환과 결과 전달을 맡는다.
//
// 소유 범위
//   REC_INJECT 주입 문자열, recording·recEvents·recRootTabs 상태, 녹화 수집·정규화·전달 수명주기.
//
// 제공 API
//   초기화·pick 결합 command, 녹화 상태와 대상 query, 주입·시작/종료·이벤트·로컬 전달 command.
//
// 의존 대상
//   browser/webview-store와 browser/webview를 import한다. main이 소유하는 BROWSER_MODE·bNote·wsSend,
//   프레임 주입 함수와 현재 pane/terminal 접근자는 init에서 받고, pick 표현·observe 호출은 pick이 등록한다.
//
// 유지 조건
//   입력값은 내용 없이 길이만 남기고 비밀번호·자동완성은 길이도 남기지 않는다. 시작 탭과 그 탭이
//   연 탭만 기록하며, 네이티브 사건은 해당 webContents만 합친다. 이벤트 상한 4000과 전달 분기를 지킨다.
//
// 영향 범위
//   guest webview executeJavaScript/framesInject, acHost의 onRecNative·recDiag·saveRecording, DOM body·bNote,
//   PTY/ws relay에 접근한다. 이 API를 바꾸면 import 하는 파일을 함께 확인한다:
//   grep -rl 'browser/record.js"' web/js

import { getWebview } from "./webview-store.js";
import {
  activeBrowserId, bindWebviewRecording, scheduleWebviewThrottling,
} from "./webview.js";

let BROWSER_MODE, bNote, wsSend, injectAllFrames, getCurTarget, getXterm;
let pickBlock = () => "";
let acBrowserCmd = async () => null;

export function initRecord(deps) {
  ({ BROWSER_MODE, bNote, wsSend, injectAllFrames, getCurTarget, getXterm } = deps);
  bindWebviewRecording({ recTracked, getRecording: () => recording });

  // 게스트 JS가 볼 수 없는 시스템 이벤트(다운로드 저장창 등)를 같은 타임라인에 합류시킨다.
  // 창 단위로 오는 이벤트라 어느 탭 것인지 걸러야 한다. 그러지 않으면 다른 탭이나 공유 브라우저에서
  // 받은 파일이 이 기록에 섞인다. wc 를 받지 못한 경우(구버전 경로)만 그대로 담는다.
  try {
    window.acHost && acHost.onRecNative && acHost.onRecNative((ev) => {
      if (!recording || !ev) return;
      if (ev.wc != null && !recordedWcs().has(ev.wc)) return;
      recPush({ ...ev });
    });
  } catch {}
}

export function bindRecordPick(deps) {
  ({ pickBlock, acBrowserCmd } = deps);
}

// 게스트에 심는 기록기. 사용자의 실제 조작을 시각(ms)·요소·좌표와 함께 남긴다. ORCA_INJECT(요소 선택)와
// 독립이다. 픽 모드는 상호작용을 가로채지만 녹화는 페이지를 그대로 두고 관찰만 한다.
// 입력값은 전부 마스킹한다: 어떤 필드든 길이만 남기고 내용은 안 남긴다.
const REC_INJECT = `(() => {
  if (window.__acRecInit) { window.__acRecSet(!!window.__acRecDesired); return; }
  window.__acRecInit = true; window.__acRecOn = false;
  // 재현에 쓸 선택자. 문서 전체에서 유일해질 때까지 조상을 붙여 올라간다. 루트 없는 사슬은
  // 다른 노드에도 걸려 재생이 엉뚱한 곳을 조작한다. 안정 후크(id·data-testid·name)가 있으면 그걸 먼저 쓴다.
  var one = function (s) { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
  var step = function (e) {
    var s = e.tagName.toLowerCase();
    var tid = e.getAttribute && (e.getAttribute('data-testid') || e.getAttribute('data-test') || e.getAttribute('name'));
    if (tid) return s + '[' + (e.getAttribute('data-testid') ? 'data-testid' : e.getAttribute('data-test') ? 'data-test' : 'name') + '=' + JSON.stringify(tid) + ']';
    if (e.classList.length) s += '.' + [].slice.call(e.classList).slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
    var sibs = e.parentElement ? [].slice.call(e.parentElement.children).filter(function (x) { return x.tagName === e.tagName; }) : [];
    if (sibs.length > 1) s += ':nth-of-type(' + ([].filter.call(e.parentElement.children, function (x) { return x.tagName === e.tagName; }).indexOf(e) + 1) + ')';
    return s;
  };
  var sel = function (el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && one('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    var parts = [], e = el, cand = null;
    for (var d = 0; e && e.nodeType === 1 && e !== document.documentElement && d < 12; e = e.parentElement, d++) {
      parts.unshift(step(e));
      cand = parts.join(' > ');
      if (one(cand)) return cand;                                  // 유일해지면 거기서 멈춘다
      if (e.id && one('#' + CSS.escape(e.id) + ' > ' + cand.slice(cand.indexOf(' > ') + 3))) break;
    }
    return cand;                                                   // 끝까지 유일하지 않으면 최장 사슬(첫 매치가 대상)
  };
  var desc = function (el) {
    if (!el || el.nodeType !== 1) return null;
    var r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), sel: sel(el), id: el.id || null,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || null,
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  };
  var emit = function (o) {
    if (window.__orcaActive && o.k !== 'nav' && o.k !== 'load' && o.k !== 'start' && o.k !== 'dialog') return; // 픽 모드 중 조작은 기록 안 함
    try { if (o.t === undefined) o.t = Math.round(performance.now()); window.postMessage({ __acRec: o }, '*'); } catch (e) {}
  };
  // 시스템 대화상자. 이벤트가 없으므로 함수를 감싼다. 오버라이드는 문서당 한 번 상시 설치하고
  // 기록 여부는 __acRecOn으로 구분한다. 녹화 중에만 감싸면 페이지가 이미 잡아둔 참조를 덮지 못한다.
  // 시각은 "열린 순간"으로 남긴다(닫힌 순간이 아니라). dur이 사람이 읽고 판단한 시간이다.
  var wrapDialog = function (name, kind) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (msg) {
      if (!window.__acRecOn) return orig.apply(window, arguments);
      var t0 = Math.round(performance.now());
      var m = (msg === undefined || msg === null) ? null : String(msg).replace(/\s+/g, ' ').slice(0, 300);
      var r, ans = 'ok';
      try { r = orig.apply(window, arguments); }
      finally {
        if (kind === 'confirm') ans = r ? 'ok' : 'cancel';
        else if (kind === 'prompt') ans = (r === null || r === undefined) ? 'cancel' : ('len:' + String(r).length); // 값은 입력이므로 마스킹
        emit({ k: 'dialog', kind: kind, msg: m, answer: ans, dur: Math.round(performance.now()) - t0, t: t0 });
      }
      return r;
    };
  };
  wrapDialog('alert', 'alert'); wrapDialog('confirm', 'confirm'); wrapDialog('prompt', 'prompt'); wrapDialog('print', 'print');
  // 페이지 이탈 확인창. 다른 리스너가 returnValue를 채웠을 때만 브라우저가 창을 띄우므로 그 흔적으로 판별한다.
  var onBeforeUnload = function (ev) {
    var rv = ev.returnValue;
    if (!ev.defaultPrevented && (rv === undefined || rv === null || rv === '')) return;
    emit({ k: 'dialog', kind: 'beforeunload', msg: typeof rv === 'string' ? rv.replace(/\s+/g, ' ').slice(0, 300) : null, answer: null, dur: 0 });
  };
  var down = null, moved = 0;
  var H = {
    pointerdown: function (ev) { down = { x: ev.clientX, y: ev.clientY, el: desc(ev.target), t: performance.now() }; moved = 0; },
    pointermove: function (ev) { if (down) moved++; },
    pointerup: function (ev) {
      if (!down) return;
      var dx = ev.clientX - down.x, dy = ev.clientY - down.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 8 && moved > 2) emit({ k: 'drag', from: { x: down.x, y: down.y }, to: { x: ev.clientX, y: ev.clientY }, el: down.el, to_el: desc(ev.target) });
      else emit({ k: 'click', at: { x: ev.clientX, y: ev.clientY }, el: down.el || desc(ev.target), btn: ev.button });
      down = null;
    },
    dblclick: function (ev) { emit({ k: 'dblclick', at: { x: ev.clientX, y: ev.clientY }, el: desc(ev.target) }); },
    contextmenu: function (ev) { emit({ k: 'contextmenu', at: { x: ev.clientX, y: ev.clientY }, el: desc(ev.target) }); },
    change: function (ev) {
      var el = ev.target; if (!el) return;
      if (el.tagName === 'SELECT') {
        var pt = inpPending.get(el); if (pt) { clearTimeout(pt); inpPending.delete(el); } // <select>는 change와 input을 둘 다 발생시킨다. 잘못된 fill 기록 방지
        var op = el.options && el.options[el.selectedIndex];
        emit({ k: 'select', el: desc(el), idx: el.selectedIndex, opt: op ? (op.text || '').trim().slice(0, 60) : null, val: op ? op.value : null });
      }
      else if (el.type === 'checkbox' || el.type === 'radio') emit({ k: 'toggle', el: desc(el), on: !!el.checked });
    },
    keydown: function (ev) {
      var k = ev.key;
      if (k === 'Enter' || k === 'Tab' || k === 'Escape' || k === 'Backspace' || k.indexOf('Arrow') === 0)
        emit({ k: 'key', v: k, el: desc(ev.target) });
    },
  };
  // 입력은 값이 아니라 "얼마나 입력했는지"만 남긴다. 연속 타이핑은 마지막 상태로 합친다.
  // 디바운스는 *필드마다* 따로 건다. 하나로 묶으면 자동완성처럼 여러 칸이 동시에 채워질 때
  // 마지막 칸만 남고 나머지가 통째로 사라진다(아이디는 없고 비밀번호만 남는 식).
  var inpPending = new Map();
  H.input = function (ev) {
    var el = ev.target; if (!el || el.tagName === 'SELECT') return;
    // 스크립트가 넣은 값(자동완성·붙여넣기 스크립트·페이지 자동세팅)은 사용자의 타이핑이 아니다.
    // 아이디·비밀번호가 이 경로로 들어오므로 길이조차 남기지 않고, autofill 표식으로 대신한다.
    if (ev.isTrusted === false) return;
    var prev = inpPending.get(el); if (prev) clearTimeout(prev);
    inpPending.set(el, setTimeout(function () {
      inpPending.delete(el);
      var v = el.value || '';
      var pw = (el.type === 'password');
      emit(pw ? { k: 'type', el: desc(el), secret: true } : { k: 'type', el: desc(el), len: v.length });
    }, 350));
  };
  var scTimer = null;
  H.scroll = function () {
    clearTimeout(scTimer);
    scTimer = setTimeout(function () { emit({ k: 'scroll', y: Math.round(window.scrollY), x: Math.round(window.scrollX) }); }, 200);
  };
  // 우리 자동완성 드롭다운은 페이지의 일부가 아니라 앱이 얹은 UI다. 그 안의 조작을 기록하면
  // 재생 때 존재하지 않는 요소를 누르게 된다(선택자도 그때그때 달라진다). 그래서 전부 제외하고,
  // "저장된 로그인에서 채웠다"는 사실 한 줄만 남겨 뒤따르는 fill이 어디서 왔는지 보이게 한다.
  var inAutofill = function (ev) {
    var t = ev && ev.target;
    return !!(t && t.closest && t.closest('[data-ac-autofill]'));
  };
  var W = {};
  for (var k in H) W[k] = (function (type, fn) {
    return function (ev) {
      if (inAutofill(ev)) { if (type === 'pointerup') emit({ k: 'autofill' }); return; }
      fn(ev);
    };
  })(k, H[k]);
  window.__acRecSet = function (on) {
    on = !!on;
    if (on === window.__acRecOn) return;
    window.__acRecOn = on;
    for (var type in W) {
      if (on) document.addEventListener(type, W[type], true);
      else document.removeEventListener(type, W[type], true);
    }
    if (on) window.addEventListener('beforeunload', onBeforeUnload); else window.removeEventListener('beforeunload', onBeforeUnload);
    if (on) emit({ k: 'start', url: location.href, title: document.title, vw: innerWidth, vh: innerHeight });
  };
  window.__acRecSet(!!window.__acRecDesired);
})();`;
export function setRecInject(el, on) {
  if (!el) return;
  const src = "window.__acRecDesired=" + (on ? "true" : "false") + ";" + REC_INJECT;
  try { el.executeJavaScript(src).catch(() => {}); } catch {}
  injectAllFrames(el, "rec", src, on);   // iframe 안 조작도 같은 타임라인에 남는다
}
export let recording = false;
let recEvents = [], recT0 = 0, recTabs = new Set();
// 녹화 대상 탭. 녹화는 "지금 보고 있는 그 탭"의 일이다.
//
// 열린 탭 전부에 기록기를 심고 전부를 스로틀 보호 대상으로 두면, 녹화를 켜는
// 순간 재우기가 풀려 잠들어 있던 탭이 한꺼번에 깨고, 그 복구 이동이 사용자의 이동으로 기록된다.
// 기록 첫머리가 사용자가 하지 않은 `goto` 수십 줄로 채워지고, 다른 탭의 조작도
// 같은 타임라인에 섞인다. 그래서 시작할 때의 탭과, 녹화 중 그 탭이 연 탭만 담는다.
// 결제창처럼 흐름의 일부로 열리는 탭은 따라가되, 무관한 탭은 건드리지 않는다.
let recRootTabs = new Set();
export function recTracked(tabId) { return recording && recRootTabs.has(tabId); }
// 녹화 대상 탭의 webContents 번호들. 창 단위로 오는 이벤트를 가릴 때 쓴다.
function recordedWcs() {
  const s = new Set();
  for (const id of recRootTabs) { const r = getWebview(id); if (r && r.wc) s.add(r.wc); }
  return s;
}
// 녹화 중 이 탭이 새 탭을 열면 그 탭도 같은 흐름이므로, 기록 대상에 넣고 기록기를 심는다.
export function recAdoptTab(tabId) {
  if (!recording || !tabId || recRootTabs.has(tabId)) return;
  recRootTabs.add(tabId);
  const r = getWebview(tabId);
  if (r && r.el) setRecInject(r.el, true);
  scheduleWebviewThrottling();
}
export function setRecording(on) {
  if (on === recording) return;
  recording = on;
  document.body.classList.toggle("recording", on);
  if (on) {
    recEvents = []; recT0 = Date.now(); recTabs = new Set();
    const root = activeBrowserId();
    recRootTabs = new Set(root ? [root] : []);
    for (const id of recRootTabs) { const rec = getWebview(id); if (rec) setRecInject(rec.el, true); }
    recNote(root
      ? "● 녹화 중: 이 탭의 조작만 기록합니다(여기서 열리는 탭은 함께). ⌘⇧A로 종료."
      : "● 녹화 중: 이 창에 브라우저 탭이 없어 기록할 것이 없습니다.");
  } else {
    for (const id of recRootTabs) { const rec = getWebview(id); if (rec) setRecInject(rec.el, false); }
    recRootTabs = new Set();
    finishRecording();
  }
  scheduleWebviewThrottling();
}
export function recNote(msg) { try { bNote.textContent = msg; bNote.hidden = false; } catch {} }
// 호스트 쪽 이벤트(내비게이션·탭 전환)도 같은 타임라인에 넣는다. 로딩과 페이지 이동이 재현의 뼈대다.
export function recPush(ev) {
  if (!recording) return;
  ev.ms = Date.now() - recT0;
  recEvents.push(ev);
  if (ev.url) recTabs.add(ev.url);
  if (recEvents.length > 4000) recEvents.splice(0, recEvents.length - 4000); // 폭주 방어
}

// 기록 → 재현 스크립트 + 로그. 스크립트는 iris-browser 명령이라 AI가 그대로 다시 돌릴 수 있다.
const ACTIONS = new Set(["click", "dblclick", "type", "key", "select", "toggle", "drag", "contextmenu"]);
const DLG = { alert: "alert", confirm: "confirm", prompt: "prompt", print: "인쇄", beforeunload: "이탈 확인", download: "다운로드 저장" };
// 대화상자 응답 표기. prompt 입력값은 마스킹 정책상 길이만 남으므로 사람이 읽는 문장으로 바꾼다.
const dlgAns = (a) => !a ? "" : a === "ok" ? " → 확인" : a === "cancel" ? " → 취소"
  : /^len:/.test(a) ? ` → 입력 ${a.slice(4)}자` : ` → ${a}`;
function recToScript(evs) {
  const out = [];
  let prev = 0, lastAction = -1e9, lastNavUrl = null;
  for (const e of evs) {
    const gap = Math.max(0, e.ms - prev); prev = e.ms;
    if (gap >= 400) out.push(`iris-browser wait ${gap}`); // 사람 속도의 딜레이를 그대로 재현
    const s = e.el && e.el.sel ? e.el.sel : null;
    if (ACTIONS.has(e.k)) lastAction = e.ms;
    if (e.k === "start") { out.push(`iris-browser goto ${e.url}`, "iris-browser wait"); lastNavUrl = e.url; }
    else if (e.k === "nav") {
      // 같은 URL 반복은 잡음. 직전 1.5초 안에 조작이 있었으면 그 조작의 결과이므로 재생하지 않는다
      // (재생 시 클릭이 이동을 일으킨다. goto를 또 넣으면 중복이고 되돌아가기까지 한다).
      if (e.url === lastNavUrl) continue;
      lastNavUrl = e.url;
      if (e.ms - lastAction < 1500) out.push(`# → 이동됨(위 조작의 결과): ${e.url}`, "iris-browser wait");
      else out.push(`iris-browser goto ${e.url}`, "iris-browser wait");
    }
    else if (e.k === "click" && s && e.el && e.el.tag === "select")
      out.push(`# ${s} 클릭(드롭다운 열기). 재생에선 아래 select 명령이 값을 넣는다. 클릭하면 네이티브 목록이 열려 멈춘다.`);
    else if (e.k === "click" && s) out.push(`iris-browser click ${JSON.stringify(s)}`);
    else if (e.k === "dblclick" && s) out.push(`iris-browser dblclick ${JSON.stringify(s)}`);
    else if (e.k === "type" && s) out.push(`iris-browser fill ${JSON.stringify(s)} ${e.secret ? '"<비밀번호>"' : `"<입력 ${e.len}자>"`}`);
    else if (e.k === "key") out.push(`iris-browser key ${e.v}`);
    else if (e.k === "select" && s) out.push(`iris-browser select ${JSON.stringify(s)} ${JSON.stringify(e.opt || e.val || String(e.idx))}`);
    else if (e.k === "scroll") out.push(`iris-browser scrollto ${e.y}`);
    else if (e.k === "drag") out.push(`# 드래그 ${e.from.x},${e.from.y} → ${e.to.x},${e.to.y} · ${s || "?"}  (iris-browser에 드래그 명령 없음: 수동 재현)`);
    else if (e.k === "toggle" && s) out.push(`iris-browser click ${JSON.stringify(s)}  # 체크박스 → ${e.on ? "on" : "off"}`);
    else if (e.k === "contextmenu" && s) out.push(`# 우클릭 ${s}`);
    else if (e.k === "autofill") out.push(`# 자동완성으로 아이디/비번 입력 (값·길이 모두 미기록: 재생 땐 직접 로그인)`);
    else if (e.k === "pick") out.push(`# ▶ 사용자가 지목한 요소: ${s || "?"}`);
    else if (e.k === "dialog") out.push(`# ⚠ ${DLG[e.kind] || e.kind} 대화상자${e.msg ? `: "${e.msg}"` : ""}${dlgAns(e.answer)}`);
  }
  return out;
}
function recToTimeline(evs) {
  return evs.map((e) => {
    const at = e.at ? ` @${e.at.x},${e.at.y}` : "";
    const el = e.el ? ` <${e.el.tag}${e.el.id ? "#" + e.el.id : ""}>${e.el.text ? ` "${e.el.text}"` : ""} — ${e.el.sel}` : "";
    const extra = e.k === "type" ? (e.secret ? " (비밀번호: 길이도 미기록)" : ` (입력 ${e.len}자, 값 미기록)`)
      : e.k === "drag" ? ` ${e.from.x},${e.from.y} → ${e.to.x},${e.to.y}`
      : e.k === "scroll" ? ` y=${e.y}`
      : e.k === "nav" || e.k === "start" ? ` ${e.url}`
      : e.k === "load" ? ` ${e.url} (${e.dur}ms)`
      : e.k === "key" ? ` ${e.v}` : "";
    if (e.k === "autofill") return `${String(e.ms).padStart(6)}ms  자동완성으로 아이디/비번 입력 (값·길이 미기록)`;
    if (e.k === "pick") return `${String(e.ms).padStart(6)}ms  선택한 요소${el}`;
    if (e.k === "load") return `${String(e.ms).padStart(6)}ms  로딩 완료 ${e.url || ""}`;
    if (e.k === "dialog") return `${String(e.ms).padStart(6)}ms  대화상자 ${DLG[e.kind] || e.kind}${e.msg ? ` "${e.msg}"` : ""}${dlgAns(e.answer)}${e.dur ? ` (${(e.dur / 1000).toFixed(1)}초 열림)` : ""}`;
    return `${String(e.ms).padStart(6)}ms  ${e.k}${extra}${at}${el}`;
  });
}
async function finishRecording() {
  const evs = recEvents.slice();
  if (!evs.length) { recNote("녹화 종료: 기록된 조작이 없습니다."); return; }
  const dur = (evs[evs.length - 1].ms / 1000).toFixed(1);
  // 그 구간의 콘솔·예외·네트워크 실패도 함께(닫힌 루프 QA 버퍼).
  //
  // `observe` 한 번으로 이 세션이 지금 보는 탭 하나만, 시간 구간 없이 가져오면
  // 여러 탭을 오가며 녹화한 기록에서 정작 문제가 난 탭의 오류가 빠지고, 녹화 전에
  // 쌓인 이전 오류가 섞인다. 그래서 녹화에 나온 탭 전부를, 녹화가 시작된 시각 이후로만 모은다.
  const recWcs = [...new Set(evs.map((e) => e.wc).filter(Boolean))];
  let logs = null, diagByWc = null;
  try { diagByWc = await (window.acHost && acHost.recDiag ? acHost.recDiag(recWcs, recT0) : null); } catch {}
  if (!diagByWc || !Object.keys(diagByWc).length) {
    try { const r = await acBrowserCmd("observe", { limit: 60 }); logs = r && r.data ? r.data : null; } catch {}
  }
  const script = recToScript(evs), timeline = recToTimeline(evs);
  const dedupe = (arr) => {
    const n = new Map();
    for (const s of arr) n.set(s, (n.get(s) || 0) + 1);
    return [...n.entries()].map(([s, c]) => (c > 1 ? `${s}  (${c}회)` : s));
  };
  // 탭이 하나뿐이면 탭 이름을 붙이지 않는다. 매 줄에 같은 값이 붙으면 읽기 어렵다.
  const oneTab = recWcs.length <= 1;
  const errLines = (d, wc) => {
    const at = oneTab || !wc ? "" : `@${wc} `;
    return [
      ...(d.exceptions || []).map((x) => `${at}예외: ` + (x.text || x.description || JSON.stringify(x)).slice(0, 200)),
      ...(d.console || []).filter((c) => /error|warn/i.test(c.level || "")).map((c) => `${at}콘솔[${c.level}] ${(c.text || "").slice(0, 200)}`),
      ...(d.network || []).map((n) => `${at}네트워크 ${n.status || "실패"} ${(n.url || "").slice(0, 120)}`),
    ];
  };
  const errs = dedupe(diagByWc
    ? Object.entries(diagByWc).flatMap(([wc, d]) => errLines(d || {}, wc))
    : (logs ? errLines(logs, null) : []));
  const picks = evs.filter((e) => e.k === "pick");
  const dlgs = evs.filter((e) => e.k === "dialog");
  // 어느 탭에서 녹화됐는지 알 수 있게, 핸들과 target 명령을 함께 준다.
  const tabSeen = new Map();
  for (const e of evs) if (e.wc) tabSeen.set(e.wc, { url: e.tabUrl || "", title: e.tabTitle || "" });
  const tabLines = [...tabSeen.entries()].map(([wc, m]) => `- @${wc}  ${m.title || "(제목 없음)"}  ${m.url}`);
  const mainWc = [...tabSeen.keys()][tabSeen.size - 1] || null;
  const head = `[브라우저 재현 기록 · ${dur}초 · 조작 ${evs.length}건${picks.length ? ` · 지목 ${picks.length}건` : ""}${dlgs.length ? ` · 대화상자 ${dlgs.length}건` : ""}${errs.length ? ` · 오류 ${errs.length}건` : ""}]`;
  // 대화상자는 재생을 멈춰 세우는 유일한 요소라 따로 세워 보여준다(스크립트 주석만으론 묻힌다).
  const dlgSection = dlgs.length ? ["", "## 시스템 대화상자", ...dlgs.map((e) =>
    `- [${Math.round(e.ms)}ms] ${DLG[e.kind] || e.kind}${e.msg ? `: "${e.msg}"` : ""}${dlgAns(e.answer)}${e.dur ? ` (${(e.dur / 1000).toFixed(1)}초 열려 있었음)` : ""}`),
    "", "재실행 스크립트 첫 줄의 `iris-browser dialogs`가 위 순서대로 자동 응답합니다(해제: iris-browser dialogs off).",
    dlgs.some((e) => e.kind === "prompt") ? "prompt는 입력값이 마스킹돼 있어 확인만 눌립니다. 값이 필요하면 `iris-browser dialogs ok \"값\"`으로." : ""] : [];
  // 사람이 실제로 누른 순서를 그대로 등록한다. 예정에 없던 대화상자는 큐가 비어 멈추므로 오히려 드러난다.
  // download는 CDP 대화상자가 아니고, print는 자동 확인하면 실제로 인쇄가 나가므로 등록에서 뺀다.
  const dlgPlan = dlgs.filter((e) => e.kind !== "download" && e.kind !== "print").map((e) => (e.answer === "cancel" ? "cancel" : "ok"));
  const dlgArm = dlgPlan.length ? [`iris-browser dialogs ${dlgPlan.join(",")}   # 녹화 때 사람이 누른 순서대로 자동 응답`] : [];
  const body = [
    head,
    "",
    "## 녹화된 탭",
    ...tabLines,
    "",
    "## 재실행 스크립트",
    "```sh",
    ...(mainWc ? [`iris-browser target ${mainWc}   # 이 세션의 제어 대상을 녹화 탭으로 고정`] : []),
    ...dlgArm,
    ...script,
    "```",
    "",
    "## 타임라인",
    "```",
    ...timeline,
    "```",
    ...(picks.length ? ["", "## 녹화 중 지목한 요소", ...picks.flatMap((e) => ["", `[${Math.round(e.ms)}ms]`, pickBlock(e.pick)])] : []),
    ...dlgSection,
    ...(errs.length ? ["", "## 이 구간의 오류", ...errs.map((e) => "- " + e)] : []),
  ].join("\n");
  // 짧으면 전문을 터미널로, 길면 요약만 넣고 전문은 파일로.
  const LIMIT = 6000;
  if (body.length <= LIMIT) { recDeliver(body); recNote(`녹화 종료: ${evs.length}건을 터미널로 보냈습니다.`); return; }
  let saved = null;
  try { saved = await (window.acHost && acHost.saveRecording ? acHost.saveRecording(body) : null); } catch {}
  const brief = [
    head,
    saved && saved.ok ? `전문: ${saved.path}` : "(파일 저장 실패: 아래 요약만)",
    "",
    "## 녹화된 탭",
    ...tabLines,
    "",
    `## 재실행 스크립트 (앞 ${Math.min(80, script.length)}줄)`,
    "```sh",
    ...(mainWc ? [`iris-browser target ${mainWc}   # 이 세션의 제어 대상을 녹화 탭으로 고정`] : []),
    ...dlgArm,
    ...script.slice(0, 80),
    script.length > 80 ? `# … ${script.length - 80}줄 더 (전문 파일 참조)` : "",
    "```",
    ...(picks.length ? ["", "## 녹화 중 지목한 요소", ...picks.flatMap((e) => ["", `[${Math.round(e.ms)}ms]`, pickBlock(e.pick)])] : []),
    ...dlgSection,
    ...(errs.length ? ["", "## 이 구간의 오류", ...errs.slice(0, 10).map((e) => "- " + e)] : []),
  ].filter(Boolean).join("\n");
  recDeliver(brief);
  recNote(`녹화 종료: 요약을 터미널로, 전문은 파일로 저장했습니다.`);
}
// 터미널 전달. 분리 창엔 터미널이 없으므로 콘솔로 relay한다(요소 pick과 같은 경로).
function recDeliver(text) {
  if (BROWSER_MODE) { wsSend({ type: "rec-relay", text }); return; }
  recDeliverLocal(text);
}
export function recDeliverLocal(text) {
  const curTarget = getCurTarget();
  if (!curTarget) { recNote("먼저 왼쪽에서 에이전트(세션)를 선택하세요."); return; }
  wsSend({ type: "pty.input", data: "\x1b[200~" + text + "\x1b[201~" });
  const xterm = getXterm();
  if (xterm) setTimeout(() => xterm.focus(), 0);
}

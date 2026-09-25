// 실행 통합: 현재 스페이스 repo의 스크립트 실행·중지·출력 tail·URL 자동 열기.
//
// 소유 범위
//   runByPath 와 render throttle: cwd별 스크립트/실행 상태/출력/자동 열기 여부.
//   run-* WebSocket 메시지 적용과 실행 패널의 클릭 연결·렌더링.
//
// 제공 API
//   initRun(deps): DOM·전송·현재 스페이스·브라우저 열기 콜백을 받는다. capability 부팅이 부른다.
//   requestRunList(): 현재 스페이스가 바뀔 때 목록과 실행 상태를 다시 묻는다.
//   "run.refresh" 이름: 스페이스 변경을 알리는 훅. main 이 이 이름으로 부른다.
//   handleRunMessage(message): run-* 메시지를 처리했으면 true를 돌려준다.
//
// 의존 대상
//   $, esc, wsSend 와 현재 스페이스 root/getter·스페이스 목록, 브라우저 탭 생성 경로를 init 에서 주입받는다.
//   center/browser/core 를 import 하지 않는다. 스페이스와 탭 상태는 아직 main 이 소유한다.
//
// 유지 조건
//   패널의 dataset.path와 현재 경로가 다르면 실행하지 않고 새로고침만 한다.
//   URL 자동 열기는 서버가 local로 판정한 첫 URL만이며, tail은 250줄로 자른다.
//   run-status는 이전 url/tail이 남지 않도록 완전 동기화한다.
//
// 영향 범위
//   main 의 스페이스 선택 두 곳(이름 호출)과 core/capabilities.js 의 등록, center/browser 탭 생성 경로.

import { provide } from "../core/hooks.js";
import { bsMutate as mutateBrowserState } from "../browser/state.js";
import { getCenterSpace } from "../center/tab-store.js";

const runByPath = {}; // cwd → { scripts, pkgmgr, running, script, url, tail:[], autoOpened }
let dom = null;
let escapeHtml = null;
let send = null;
let browserMode = false;
let spaceRootFor = null;
let getSelectedSpaceId = null;
let getSpaces = null;
let openBrowser = null;
let consoleSpace = null;
let newTabId = null;
let runRenderT = null;

export function initRun(deps) {
  // 스페이스가 바뀌면 목록을 다시 물어야 한다. 그것을 부르는 쪽(main)이 이 모듈을 import 하면
  // 이 기능을 끈 사람에게도 로드되므로 이름만 등록한다. 로드되지 않았으면 호출되지 않는다.
  provide("run.refresh", requestRunList);
  dom = deps.$;
  escapeHtml = deps.esc;
  send = deps.wsSend;
  browserMode = !!deps.browserMode;
  spaceRootFor = deps.spaceRootFor;
  getSelectedSpaceId = deps.getSelectedSpaceId;
  getSpaces = deps.getSpaces;
  openBrowser = deps.openBrowser;
  consoleSpace = deps.consoleSpace;
  newTabId = deps.newTabId;
  const body = dom("#run-body"); if (!body || browserMode) return;
  body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-open-url]"); if (chip) { runAutoOpenUrl(chip.dataset.openUrl); return; }
    const btn = e.target.closest("[data-run-act]"); if (!btn) return;
    const p = curRunPath(); if (!p) return;
    if (body.dataset.path && body.dataset.path !== p) { requestRunList(); return; } // 패널이 이전 스페이스 것 → 남의 스크립트 실행 방지, 새로고침만(M3)
    if (btn.dataset.runAct === "start") send({ type: "run.start", path: p, script: btn.dataset.script });
    else send({ type: "run.stop", path: p });
  });
}

// 경로는 고른 스페이스 하나에서만 찾는다. 에이전트가 없는 스페이스(홈 등)는 그 스페이스의 폴더를 쓰고,
// 다른 스페이스 경로로 대신하지 않는다. 대신하면 패널과 실행 보호가 둘 다 남의 프로젝트를 가리킨다.
function curRunPath() {
  const sp = getSelectedSpaceId() || getCenterSpace();
  if (!sp) return null;
  const s = (getSpaces?.() || []).find((x) => x.id === sp);
  return spaceRootFor(sp) || (s && s.folder) || null;
}
function runRec(p) { if (!runByPath[p]) runByPath[p] = { scripts: {}, pkgmgr: "npm", running: false, script: null, url: null, tail: [], autoOpened: false }; return runByPath[p]; }
export function requestRunList() { const p = curRunPath(); if (!p) { renderRun(); return; } send({ type: "run.list", path: p }); send({ type: "run.status", path: p }); }
function renderRunThrottled() { if (runRenderT) return; runRenderT = setTimeout(() => { runRenderT = null; renderRun(); }, 200); }
function renderRun() {
  const body = dom("#run-body"); if (!body) return;
  const p = curRunPath();
  if (!p) { body.innerHTML = '<div class="fempty">스페이스를 선택하세요.</div>'; const m0 = dom("#run-meta"); if (m0) m0.textContent = ""; return; }
  const r = runRec(p); const names = Object.keys(r.scripts || {});
  let html = "";
  if (!names.length) html = '<div class="fempty">package.json 스크립트 없음.</div>';
  else {
    // 왼쪽은 스크립트 목록, 오른쪽은 열린 주소와 출력이다.
    const items = names.map((n) => {
      const isRun = r.running && r.script === n;
      return `<div class="run-item${isRun ? " running" : ""}" data-script="${escapeHtml(n)}"><span class="run-dot${isRun ? " on" : ""}"></span><span class="r-name" title="${escapeHtml(r.scripts[n] || "")}">${escapeHtml(n)}</span><button class="r-btn" data-run-act="${isRun ? "stop" : "start"}" data-script="${escapeHtml(n)}" title="${isRun ? "중지" : "실행"}" aria-label="${escapeHtml(n)} ${isRun ? "중지" : "실행"}">${isRun ? RUN_ICON.stop : RUN_ICON.play}</button></div>`;
    }).join("");
    const url = r.url ? `<div class="run-url-chip" data-open-url="${escapeHtml(r.url)}" title="브라우저에서 열기">${RUN_ICON.globe}<span class="run-url">${escapeHtml(r.url)}</span><span class="run-url-go">브라우저에서 열기</span></div>` : "";
    const out = r.tail && r.tail.length
      ? `<div class="run-out" id="run-out">${escapeHtml(r.tail.slice(-60).join("\n"))}</div>`
      : `<div class="run-out run-out-empty">${r.running ? "출력을 기다리는 중…" : "스크립트를 실행하면 출력이 여기에 나옵니다."}</div>`;
    html = `<div class="run-grid"><div class="run-scripts">${items}</div><div class="run-side">${url}${out}</div></div>`;
  }
  body.innerHTML = html;
  body.dataset.path = p; // 이 패널이 어느 프로젝트로 렌더됐는지: 클릭 시 현재 스페이스와 대조(M3)
  const out = dom("#run-out"); if (out) out.scrollTop = out.scrollHeight;
  // 접힌 머리 줄에도 지금 도는 스크립트와 패키지 관리자를 함께 보인다.
  const mt = dom("#run-meta");
  if (mt) mt.innerHTML = (r.running ? `<span class="run-meta-on">▶ ${escapeHtml(r.script || "")}</span>` : "")
    + (names.length ? `<span class="run-meta-pm">${escapeHtml(r.pkgmgr)}</span>` : "");
}
const RUN_ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
};
function runAutoOpenUrl(u) {
  try { openBrowser(); const sp = consoleSpace(); const id = newTabId(); mutateBrowserState({ op: "tab.open", space: sp, id, url: u, title: "실행" }); } catch {}
}

export function handleRunMessage(m) {
  if (m.type === "run-scripts") {
    const r = runRec(m.path); if (m.ok) { r.scripts = m.scripts || {}; r.pkgmgr = m.pkgmgr || "npm"; } else r.scripts = {};
    if (m.path === curRunPath()) renderRun();
  } else if (m.type === "run-status") {
    const r = runRec(m.path); r.running = !!m.running; r.script = m.script || null; r.url = m.url || null; if (Array.isArray(m.tail)) r.tail = m.tail; if (m.pkgmgr) r.pkgmgr = m.pkgmgr; // 완전 동기화(이전 url/tail 잔존 방지, L12)
    if (m.path === curRunPath()) renderRun();
  } else if (m.type === "run-started") {
    const r = runRec(m.cwd); r.running = true; r.script = m.script; r.pkgmgr = m.pkgmgr || r.pkgmgr; r.url = null; r.tail = []; r.autoOpened = false;
    if (m.cwd === curRunPath()) renderRun();
  } else if (m.type === "run-output") {
    const r = runRec(m.cwd); for (const line of String(m.data || "").split(/\r?\n/)) { if (line !== "") r.tail.push(line); } if (r.tail.length > 250) r.tail.splice(0, r.tail.length - 250);
    if (m.cwd === curRunPath()) renderRunThrottled();
  } else if (m.type === "run-url") {
    const r = runRec(m.cwd); r.url = m.url; if (!r.autoOpened && m.local) { r.autoOpened = true; runAutoOpenUrl(m.url); } // 로컬호스트 URL만 자동오픈(스크립트 출력의 외부 URL로 유도 차단, M7). 외부는 칩만 표시
    if (m.cwd === curRunPath()) renderRun();
  } else if (m.type === "run-exit") {
    const r = runRec(m.cwd); r.running = false; r.tail.push(`[종료: code ${m.code == null ? "-" : m.code}${m.signal ? " " + m.signal : ""}]`);
    if (m.cwd === curRunPath()) renderRun();
  } else if (m.type === "run-error") {
    const r = runRec(m.path || ""); if (m.error) r.tail.push("[오류] " + m.error);
    if ((m.path || "") === curRunPath()) renderRun();
  } else return false;
  return true;
}

// 이 기능의 연결. 표에는 선언만 남고, 연결 방법은 각 기능이 소유한다.
export function initCapability(ctx) {
  initRun({
    $: ctx.$, esc: ctx.esc, wsSend: ctx.wsSend, browserMode: ctx.browserMode,
    spaceRootFor: ctx.spaceRootFor, getSelectedSpaceId: ctx.getSelectedSpaceId, getSpaces: ctx.getSpaces,
    openBrowser: ctx.openBrowser, consoleSpace: ctx.consoleSpace, newTabId: ctx.newTabId,
  });
  const on = handleRunMessage;
  return {
    ws: {
      "run-scripts": on, "run-status": on, "run-started": on,
      "run-output": on, "run-url": on, "run-exit": on, "run-error": on,
    },
  };
}
